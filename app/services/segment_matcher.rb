# Analyse de segments d'UNE activité : retrouve les portions de son tracé déjà
# parcourues lors d'autres sorties, et chronomètre chaque passage.
#
# Aucun segment n'est défini à la main ni repris de Strava : les segments sont
# *découverts* en comparant les empreintes de trace (`TrackFingerprint`, colonne
# `track_cells`). Deux sorties sur le même chemin traversent les mêmes cellules de
# grille dans le même ordre — chercher un chemin commun revient donc à chercher une
# sous-suite commune, en tolérant les cellules manquées (bruit GPS, bascule d'un
# côté à l'autre d'une frontière de cellule).
#
# Pipeline :
#   1. candidats  — activités de l'utilisateur passées dans la même zone (préfiltre
#                   SQL sur les cellules grossières) et de la même catégorie de sport
#   2. diagonales — sous-suites communes avec l'activité courante, dans les deux sens
#   3. segments   — regroupement des passages qui couvrent la même portion, temps de
#                   chacun recalculé sur la portion COMMUNE (sinon incomparables)
#
# Les activités dont les streams n'ont jamais été récupérés n'ont pas d'empreinte et
# sont donc invisibles ici : c'est le backfill des streams qui peuple l'historique.
class SegmentMatcher
  # Longueur minimale d'un segment. En dessous, ce n'est pas un « chemin » mais un
  # croisement ou un bout de rue partagé par hasard.
  MIN_SEGMENT_M = 500
  # Trous tolérés (en cellules) lors du recollage de deux diagonales : le GPS peut
  # sauter une cellule, ou en insérer une, sans que le chemin change.
  MERGE_GAP_CELLS = 6
  # Décalage de diagonale toléré au recollage : une insertion/suppression de cellule
  # décale l'alignement d'un cran, pas plus de quelques-uns sur une portion continue.
  MERGE_OFFSET = 4
  # Longueur minimale d'une diagonale brute (en cellules) avant recollage.
  MIN_RUN_CELLS = 3
  # Part des cellules réellement appariées sur la plage retenue. En dessous, les deux
  # tracés se frôlent (routes parallèles) plus qu'ils ne se superposent.
  MIN_MATCH_RATIO = 0.6
  # Écart de longueur toléré entre les deux côtés d'un appariement.
  MAX_LENGTH_DRIFT = 0.3
  # Recouvrement (part de la portion la plus courte) à partir duquel deux passages
  # sont considérés comme étant sur le MÊME segment.
  OVERLAP_RATIO = 0.6
  # Bornes de coût : la comparaison fine est en O(appariements) par candidat.
  MAX_CANDIDATES = 300
  MAX_SEGMENTS = 30
  # Passages détaillés dans le panneau dépliable (le compteur, lui, reste complet).
  MAX_LISTED_EFFORTS = 40
  # Places distinguées d'une médaille (or, argent, bronze).
  PODIUM_PLACES = 3
  # Bruit barométrique ignoré dans le cumul de dénivelé du segment.
  ELEVATION_NOISE_M = 1.0

  # Bumper invalide les résultats déjà en cache (`ActivitiesController` / contrôleurs
  # d'activité), en plus de `UserActivities.data_version`.
  CACHE_VERSION = 4

  # `fp` = l'empreinte du candidat, déjà chargée : le chronométrage sur la portion
  # commune la relit sans requête supplémentaire.
  Effort = Struct.new(:source, :external_id, :name, :started_at, :reverse,
                      :a_start, :a_end, :b_start, :b_end, :cells, :fp, :own, keyword_init: true)

  # Résultat mis en cache : le calcul balaie tout l'historique proche, mais il ne
  # change que si les activités changent — même clé versionnée que les autres
  # analyses transversales (`PerformanceRecords`, `TrainingLoad`).
  def self.for(user, activity)
    source = activity.is_a?(StravaActivity) ? 'strava' : 'imported'
    key = ['activity_segments', CACHE_VERSION, source, activity.id,
           UserActivities.data_version(user.id), naming_version(user)].join('/')
    Rails.cache.fetch(key, expires_in: 12.hours) { new(user, activity).call }
  end

  # Les noms font partie du résultat : renommer un segment doit invalider le cache
  # de toutes les activités qui le traversent, d'où cette empreinte dans la clé.
  def self.naming_version(user)
    agg = user.named_segments.pick(Arel.sql('COUNT(*), MAX(updated_at)'))
    "#{agg&.first || 0}:#{agg&.last&.to_f || 0}"
  end

  def initialize(user, activity)
    @user = user
    @activity = activity
    @fingerprint = activity.track_cells.presence || {}
  end

  # Renvoie `[{ start_idx:, end_idx:, distance_m:, … }]`, trié par nombre de passages
  # décroissant. Tableau vide si l'activité n'a pas de tracé exploitable ou si aucune
  # portion n'a été refaite.
  def call
    return [] if a_cells.length < 2

    efforts = candidates.flat_map { |row| efforts_against(row) }
    return [] if efforts.empty?

    segments = cluster(efforts).filter_map { |cluster| build_segment(cluster) }
    # Le podium d'abord (or, argent, bronze) : c'est l'information qu'on cherche en
    # ouvrant l'onglet. Ensuite les chemins les plus refaits, puis les plus longs. Le
    # tri précède le plafonnement, donc une médaille n'est jamais coupée au profit
    # d'un chemin banal.
    segments.sort_by { |s| [s[:current][:podium] || PODIUM_PLACES + 1, -s[:count], -s[:distance_m]] }
            .first(MAX_SEGMENTS)
  end

  private

  attr_reader :user, :activity, :fingerprint

  def a_cells  = @a_cells  ||= Array(fingerprint['cells'])
  def a_times  = @a_times  ||= Array(fingerprint['t'])
  def a_dists  = @a_dists  ||= Array(fingerprint['d'])
  def a_idx    = @a_idx    ||= Array(fingerprint['i'])
  def a_coarse = @a_coarse ||= Array(fingerprint['coarse'])

  def sport_category = @sport_category ||= PerformanceRecords.sport_category(activity.activity_type)

  # ── 1. Candidats ───────────────────────────────────────────────────────────
  # Le préfiltre sur les cellules grossières doit vivre DANS chaque branche (une
  # requête par table) pour que l'index GIN d'expression serve : d'où deux requêtes
  # AR plutôt que le `UNION ALL` de `UserActivities`. On ne charge les empreintes
  # (volumineuses) qu'après avoir écarté les mauvaises catégories de sport.
  def candidates
    return [] if a_coarse.empty?

    rows = UserActivities::SOURCES.flat_map do |source, cfg|
      klass = source == 'strava' ? StravaActivity : ImportedActivity
      klass.where(user_id: user.id)
           .where(Arel.sql("(track_cells -> 'coarse') ?| ARRAY[#{quoted_coarse}]"))
           .order(started_at: :desc)
           .limit(MAX_CANDIDATES)
           .pluck(cfg[:id_column], :name, :started_at, :activity_type)
           .map { |id, name, started_at, type|
             { source: source, external_id: id.to_s, name: name, started_at: started_at, type: type }
           }
    end

    rows = rows.reject { |r| same_activity?(r) }
               .select { |r| PerformanceRecords.sport_category(r[:type]) == sport_category }
               .sort_by { |r| r[:started_at] || Time.at(0) }
               .reverse
               .first(MAX_CANDIDATES)

    # La sortie affichée est son PROPRE candidat : c'est comme ça qu'on repère un
    # aller-retour (elle emprunte deux fois le même chemin, en sens opposés). Ajoutée
    # à part pour qu'elle échappe au plafond `MAX_CANDIDATES`.
    attach_fingerprints(rows) + [self_row]
  end

  # Candidat « moi-même », monté depuis l'empreinte déjà chargée.
  def self_row
    { source: current_source, external_id: current_external_id, name: activity.name,
      started_at: activity.started_at, fingerprint: fingerprint, own: true }
  end

  def quoted_coarse
    a_coarse.map { |key| UserActivities.quote(key) }.join(',')
  end

  def same_activity?(row)
    row[:source] == current_source && row[:external_id] == current_external_id
  end

  def current_source = @current_source ||= activity.is_a?(StravaActivity) ? 'strava' : 'imported'

  def current_external_id
    @current_external_id ||= (activity.is_a?(StravaActivity) ? activity.strava_id : activity.id).to_s
  end

  # Deuxième passe : les empreintes des seuls candidats retenus.
  def attach_fingerprints(rows)
    by_source = rows.group_by { |r| r[:source] }
    by_source.each do |source, source_rows|
      cfg = UserActivities::SOURCES.fetch(source)
      klass = source == 'strava' ? StravaActivity : ImportedActivity
      prints = klass.where(user_id: user.id, cfg[:id_column] => source_rows.map { |r| r[:external_id] })
                    .pluck(cfg[:id_column], :track_cells)
                    .to_h { |id, cells| [id.to_s, cells] }
      source_rows.each { |r| r[:fingerprint] = prints[r[:external_id]] || {} }
    end
    rows.select { |r| Array(r[:fingerprint]['cells']).length >= 2 }
  end

  # ── 2. Diagonales communes ─────────────────────────────────────────────────
  # Une diagonale = une suite de cellules appariées avec un décalage constant entre
  # les deux tracés (`j - i` dans le sens direct, `j + i` en sens inverse). Les
  # diagonales voisines sont recollées : une cellule sautée décale l'alignement d'un
  # cran sans que le chemin change.
  def efforts_against(row)
    b_cells = Array(row[:fingerprint]['cells'])
    positions = position_index(b_cells)

    [false, true].flat_map do |reverse|
      merge_runs(raw_runs(positions, reverse), reverse)
        .reject { |run| identity_run?(run, row, reverse) }
        .filter_map { |run| effort_from(run, row, reverse) }
    end
  end

  # Comparée à elle-même, une trace s'apparie d'abord avec… elle-même : diagonale de
  # décalage nul, dans le sens direct. On l'écarte — refaire deux fois le même chemin
  # dans la même sortie donne, lui, un décalage franc.
  def identity_run?(run, row, reverse)
    row[:own] && !reverse && (run[:b_start] - run[:a_start]).abs < MIN_RUN_CELLS
  end

  def position_index(cells)
    index = Hash.new { |h, k| h[k] = [] }
    cells.each_with_index { |cell, j| index[cell] << j }
    index
  end

  # Diagonales brutes, par décalage. `open` garde la diagonale en cours pour chaque
  # décalage ; on la clôt dès que l'écart en i devient trop grand.
  def raw_runs(positions, reverse)
    open = {}
    closed = []

    a_cells.each_with_index do |cell, i|
      hits = positions[cell]
      next if hits.empty?

      hits.each do |j|
        offset = reverse ? j + i : j - i
        run = open[offset]
        if run && i - run[:a_end] <= MERGE_GAP_CELLS
          run[:a_end] = i
          run[:b_end] = j
          run[:cells] += 1
        else
          closed << run if run && run[:cells] >= MIN_RUN_CELLS
          open[offset] = { a_start: i, a_end: i, b_start: j, b_end: j, cells: 1, offset: offset }
        end
      end
    end

    closed.concat(open.values.select { |run| run[:cells] >= MIN_RUN_CELLS })
    closed.sort_by { |run| [run[:a_start], run[:a_end]] }
  end

  # Recollage : deux diagonales proches en i, de décalages voisins et progressant
  # dans le bon sens sur le candidat, décrivent le même passage.
  def merge_runs(runs, reverse)
    merged = []
    runs.each do |run|
      prev = merged.last
      if prev && run[:a_start] - prev[:a_end] <= MERGE_GAP_CELLS &&
         (run[:offset] - prev[:offset]).abs <= MERGE_OFFSET &&
         progressing?(prev, run, reverse)
        prev[:a_end] = [prev[:a_end], run[:a_end]].max
        prev[:b_end] = run[:b_end]
        prev[:cells] += run[:cells]
        prev[:offset] = run[:offset]
      else
        merged << run.dup
      end
    end
    merged
  end

  def progressing?(prev, run, reverse)
    reverse ? run[:b_end] <= prev[:b_end] : run[:b_end] >= prev[:b_end]
  end

  # Valide une diagonale recollée : assez longue, assez dense, et de longueur
  # cohérente des deux côtés (sinon on a recollé deux passages distincts).
  def effort_from(run, row, reverse)
    span = run[:a_end] - run[:a_start] + 1
    return nil if span < MIN_RUN_CELLS
    return nil if run[:cells].to_f / span < MIN_MATCH_RATIO

    length_a = span_metres(a_dists, run[:a_start], run[:a_end])
    return nil if length_a < MIN_SEGMENT_M

    b_dists = Array(row[:fingerprint]['d'])
    length_b = span_metres(b_dists, run[:b_start], run[:b_end])
    return nil if length_b <= 0
    return nil if (length_a - length_b).abs / length_a > MAX_LENGTH_DRIFT

    Effort.new(
      source: row[:source], external_id: row[:external_id], name: row[:name],
      started_at: row[:started_at], reverse: reverse,
      a_start: run[:a_start], a_end: run[:a_end],
      b_start: run[:b_start], b_end: run[:b_end], cells: run[:cells],
      fp: row[:fingerprint], own: row[:own] || false
    )
  end

  def span_metres(dists, from, to)
    a = dists[[from, to].min].to_f
    b = dists[[from, to].max].to_f
    (b - a).abs
  end

  # ── 3. Regroupement en segments ────────────────────────────────────────────
  # Les passages qui couvrent la même portion de l'activité courante forment un
  # segment ; sa plage est l'INTERSECTION des plages du groupe, pour que tous les
  # temps portent sur exactement le même chemin.
  def cluster(efforts)
    clusters = []
    # Du plus long au plus court : le premier passage fixe la portion, les suivants
    # la rognent. Un passage n'est rattaché que si l'intersection reste un segment.
    efforts.sort_by { |e| -(e.a_end - e.a_start) }.each do |effort|
      target = clusters.find { |c| fits?(c, effort) }
      if target
        target[:a_start] = [target[:a_start], effort.a_start].max
        target[:a_end] = [target[:a_end], effort.a_end].min
        target[:efforts] << effort
      else
        clusters << { a_start: effort.a_start, a_end: effort.a_end, efforts: [effort] }
      end
    end
    clusters
  end

  def fits?(cluster, effort)
    return false if overlap_ratio(cluster[:a_start], cluster[:a_end], effort.a_start, effort.a_end) < OVERLAP_RATIO

    span_metres(a_dists, [cluster[:a_start], effort.a_start].max,
                [cluster[:a_end], effort.a_end].min) >= MIN_SEGMENT_M
  end

  # Part de la portion la plus courte couverte par les deux plages (en mètres).
  def overlap_ratio(s1, e1, s2, e2)
    lo = [s1, s2].max
    hi = [e1, e2].min
    return 0.0 if hi <= lo

    shortest = [span_metres(a_dists, s1, e1), span_metres(a_dists, s2, e2)].min
    shortest.positive? ? span_metres(a_dists, lo, hi) / shortest : 0.0
  end

  def build_segment(cluster)
    start_cell = cluster[:a_start]
    end_cell = cluster[:a_end]
    distance = span_metres(a_dists, start_cell, end_cell)
    return nil if distance < MIN_SEGMENT_M

    start_idx = a_idx[start_cell].to_i
    end_idx = a_idx[end_cell].to_i
    current_duration = (a_times[end_cell].to_f - a_times[start_cell].to_f).round
    return nil unless current_duration.positive?

    # Le sens affiché est ABSOLU quand le segment est nommé : c'est l'ordre des
    # cellules enregistré au baptême qui fait référence, pas la sortie regardée. La
    # sortie affichée peut donc elle-même être « en sens inverse ».
    naming = naming(start_cell, end_cell)
    current_reverse = naming[:current_reverse]
    # Fenêtre temporelle du passage de cette sortie : un passage d'elle-même qui la
    # chevauche n'est pas un vrai deuxième passage (on ne peut pas être deux fois au
    # même endroit au même moment) mais une trace qui s'apparie avec elle-même — GPS
    # qui zigzague, arrêt, lacet de montée.
    window = [a_times[start_cell].to_f, a_times[end_cell].to_f]
    efforts = cluster[:efforts].filter_map { |e| effort_json(e, start_cell, end_cell, current_reverse, window) }

    # Les passages en sens opposé ne sont pas comparables : on ne les montre QUE si
    # cette sortie fait elle-même l'aller-retour sur le segment (elle l'emprunte dans
    # les deux sens) — là, le sens opposé fait partie de la sortie et l'afficher a du
    # sens. Sinon on s'en tient au sens parcouru.
    out_and_back = efforts.any? { |e| e[:own] && e[:reverse] != current_reverse }
    efforts = efforts.select { |e| e[:reverse] == current_reverse } unless out_and_back
    return nil if efforts.empty?

    # Un passage en sens inverse (montée vs descente) n'est pas comparable : il
    # compte dans le nombre de fois, jamais dans le classement ni le record. Les
    # passages comparables sont ceux qui vont dans le même sens que la sortie
    # affichée — d'où la comparaison à `current_reverse` et non à `false`.
    same_way = efforts.select { |e| e[:reverse] == current_reverse }
    ranked = ([current_duration] + same_way.map { |e| e[:duration_s] }).sort
    best = same_way.min_by { |e| e[:duration_s] }

    {
      start_idx: start_idx,
      end_idx: end_idx,
      distance_m: distance.round,
      elevation_gain_m: elevation_gain(start_idx, end_idx),
      count: efforts.length + 1,
      # Passages à contresens de la sortie affichée : ne reste non nul que dans le cas
      # de l'aller-retour, les autres ayant été écartés au-dessus.
      reverse_count: efforts.count { |e| e[:reverse] != current_reverse },
      current: current_json(current_duration, ranked, current_reverse),
      # `best` = meilleur des AUTRES passages : l'activité du jour n'y figure pas,
      # c'est son rang (1 = record) qui dit qu'elle a fait mieux.
      best: best,
      efforts: recent_efforts(efforts, best)
    }.merge(naming.except(:current_reverse))
  end

  # Place de la sortie affichée parmi les passages COMPARABLES (même sens).
  # `podium` (1/2/3) exige qu'il y ait quelqu'un derrière : 2ᵉ sur 2, ce n'est pas
  # une médaille d'argent, c'est le dernier. `record` = la marche du haut.
  def current_json(duration, ranked, reverse)
    rank = ranked.index(duration).to_i + 1
    podium = rank <= PODIUM_PLACES && ranked.length > rank ? rank : nil
    { duration_s: duration, rank: rank, total: ranked.length, reverse: reverse,
      podium: podium, record: podium == 1 }
  end

  # Nom donné par l'utilisateur, s'il a déjà baptisé ce chemin depuis une autre
  # sortie (`NamedSegment`, rapprochement sur les cellules). `id` permet au front de
  # renommer / supprimer le nom sans relire la liste.
  def naming(start_cell, end_cell)
    cells = a_cells[start_cell..end_cell] || []
    best = named_segments.map { |ns| [ns, ns.overlap_with(cells)] }.max_by(&:last)
    # Sans nom, il n'existe pas de sens de référence : la sortie affichée fait foi,
    # elle est donc « direct » par construction.
    unless best && best.last >= NamedSegment::MATCH_RATIO
      return { named_segment_id: nil, name: nil, current_reverse: false }
    end

    { named_segment_id: best.first.id, name: best.first.name,
      current_reverse: best.first.reversed_for?(cells) }
  end

  def named_segments
    @named_segments ||= user.named_segments.in_coarse(a_coarse).to_a
  end

  # Historique renvoyé au front. On plafonne sur les passages les PLUS RÉCENTS (plus
  # le meilleur s'il est plus ancien) — `count` reste le total, un chemin quotidien
  # peut compter des centaines de passages qu'on ne va pas dérouler —, puis on rend
  # la liste triée par sens (celui de référence d'abord) et par temps croissant :
  # deux sens différents ne se comparent pas, les mettre en vis-à-vis n'a pas de sens.
  def recent_efforts(efforts, best)
    listed = efforts.sort_by { |e| e[:started_at].to_s }.reverse.first(MAX_LISTED_EFFORTS)
    listed << best if best && !listed.include?(best)
    listed.sort_by { |e| [e[:reverse] ? 1 : 0, e[:duration_s]] }
  end

  # Temps d'un passage sur la portion COMMUNE : la plage du candidat est ramenée à
  # la plage du segment par la proportion le long de la diagonale (les cellules sont
  # de taille fixe, donc l'index est proportionnel à la distance parcourue).
  # `current_reverse` : sens de la sortie affichée par rapport au sens de référence du
  # segment nommé. Les diagonales, elles, sont calculées PAR RAPPORT à cette sortie —
  # on rebascule donc le drapeau pour l'exposer en absolu.
  def effort_json(effort, start_cell, end_cell, current_reverse, window)
    b_from = project(effort, start_cell)
    b_to = project(effort, end_cell)
    times = Array(effort.fp['t'])
    duration = (times[b_to].to_f - times[b_from].to_f).abs.round
    return nil unless duration.positive?
    return nil if effort.own && overlaps?(window, [times[b_from].to_f, times[b_to].to_f].minmax)

    { source: effort.source, external_id: effort.external_id, name: effort.name,
      started_at: effort.started_at&.iso8601, duration_s: duration, own: effort.own,
      reverse: current_reverse ? !effort.reverse : effort.reverse }
  end

  # Deux intervalles de temps se chevauchent-ils ? (bornes déjà ordonnées)
  def overlaps?(a, b)
    a.first <= b.last && b.first <= a.last
  end

  def project(effort, a_cell)
    span = effort.a_end - effort.a_start
    ratio = span.positive? ? (a_cell - effort.a_start).to_f / span : 0.0
    ratio = ratio.clamp(0.0, 1.0)
    (effort.b_start + ((effort.b_end - effort.b_start) * ratio)).round
  end

  # Cumul des montées entre deux index de stream de l'activité courante, seuil de
  # bruit barométrique comme le profil d'altitude du front.
  def elevation_gain(start_idx, end_idx)
    alts = TrackFingerprint.stream_values(activity.streams, 'altitude')
    return nil unless alts.is_a?(Array) && alts.length > end_idx

    gain = 0.0
    ref = alts[start_idx]
    (start_idx..end_idx).each do |i|
      value = alts[i]
      next unless value.is_a?(Numeric)
      next ref = value unless ref.is_a?(Numeric)

      delta = value - ref
      if delta >= ELEVATION_NOISE_M
        gain += delta
        ref = value
      elsif delta <= -ELEVATION_NOISE_M
        ref = value
      end
    end
    gain.round
  end
end
