# Répartition du temps d'entraînement par zone d'intensité (fréquence cardiaque et
# puissance). Le calcul se fait en deux temps, sur le modèle de `peak_powers` :
#
#   1. À l'enregistrement des streams (Activityable#store_streams!), on condense la
#      série FC/watts en un HISTOGRAMME compact : secondes passées par palier fixe
#      (5 bpm / 25 W). C'est un dérivé intrinsèque de la sortie, indépendant des
#      seuils de l'athlète, donc stocké tel quel (`hr_histogram`, `power_histogram`).
#
#   2. À la lecture (page performance), on regroupe ces histogrammes en ZONES en
#      appliquant la LTHR / FTP COURANTES. Comme le regroupement est fait à la volée,
#      modifier un seuil recolore aussitôt la répartition — aucune donnée obsolète.
#
# Zones FC : % de la LTHR (5 zones, modèle seuil). Zones puissance : % de la FTP
# (7 zones de Coggan). Bornes = fraction basse incluse, fraction haute exclue.
module ZoneDistribution
  module_function

  HR_BUCKET = 5      # largeur d'un palier FC (bpm)
  POWER_BUCKET = 25  # largeur d'un palier puissance (W)

  # Bornes basses (fraction du seuil) des zones, la borne haute étant la borne basse
  # de la zone suivante (dernière zone = ouverte vers +∞).
  HR_ZONES = [
    { key: 'z1', lo: 0.0 },  # récupération
    { key: 'z2', lo: 0.81 }, # endurance
    { key: 'z3', lo: 0.90 }, # tempo
    { key: 'z4', lo: 0.94 }, # seuil
    { key: 'z5', lo: 1.00 }  # VO2max+
  ].freeze

  POWER_ZONES = [
    { key: 'z1', lo: 0.0 },   # récupération active
    { key: 'z2', lo: 0.55 },  # endurance
    { key: 'z3', lo: 0.75 },  # tempo
    { key: 'z4', lo: 0.90 },  # seuil
    { key: 'z5', lo: 1.05 },  # VO2max
    { key: 'z6', lo: 1.20 },  # anaérobie
    { key: 'z7', lo: 1.50 }   # neuromusculaire
  ].freeze

  # ── Étape 1 : histogramme compact depuis les streams ────────────────────────
  # Renvoie `{ "palier_bas" => secondes }` (clés String, comme le JSONB relu).
  # Pondère chaque échantillon par la durée qui le sépare du suivant (stream `time`,
  # sinon 1 s), en ignorant les pauses (Δt aberrant) pour ne pas gonfler une zone.
  def histogram(streams, channel, bucket)
    values = PeakPowerCurve.stream_values(streams, channel)
    return {} unless values.is_a?(Array) && values.length >= 2

    times = PeakPowerCurve.stream_values(streams, 'time')
    out = Hash.new(0.0)
    values.each_with_index do |v, i|
      next unless v.is_a?(Numeric) && v.finite? && v.positive?

      dt = sample_dt(times, i, values.length)
      next if dt <= 0

      out[((v / bucket).floor * bucket).to_s] += dt
    end
    out.transform_values { |s| s.round(1) }
  end

  # Δt (s) attribué à l'échantillon i : écart au suivant via le stream `time`, borné à
  # MAX_GAP pour écarter les arrêts (feu rouge, pause). 1 s par défaut (pas de `time`).
  MAX_GAP = 10
  def sample_dt(times, i, n)
    return 1.0 if i >= n - 1 # dernier point : pas d'intervalle « vers le suivant »
    return 1.0 unless times.is_a?(Array) && times[i].is_a?(Numeric) && times[i + 1].is_a?(Numeric)

    dt = times[i + 1].to_f - times[i].to_f
    dt.positive? ? [dt, MAX_GAP].min : 0.0
  end

  # ── Étape 2 : regroupement d'un histogramme en zones pour un seuil donné ─────
  # `zones` = HR_ZONES ou POWER_ZONES ; `threshold` = LTHR (bpm) ou FTP (W). Chaque
  # palier est classé par son point milieu. Renvoie `{ "z1" => secondes, … }`.
  def bucketize(histogram, threshold, zones, bucket)
    return {} unless threshold&.positive? && histogram.is_a?(Hash)

    acc = Hash.new(0.0)
    histogram.each do |low, secs|
      mid = low.to_f + bucket / 2.0
      frac = mid / threshold
      acc[zone_key(frac, zones)] += secs.to_f
    end
    acc
  end

  # Clé de la zone contenant `frac` (fraction du seuil) : dernière zone dont la borne
  # basse est ≤ frac.
  def zone_key(frac, zones)
    zone = zones.reverse_each.find { |z| frac >= z[:lo] } || zones.first
    zone[:key]
  end

  # Somme deux accumulateurs `{ zone => secondes }` (pour cumuler plusieurs sorties).
  def merge_zone_seconds(into, other)
    other.each { |k, v| into[k] = (into[k] || 0.0) + v }
    into
  end

  # Met en forme un accumulateur `{ zone => secondes }` pour le front : liste ordonnée
  # `[{ zone:, seconds:, pct: }]` sur toutes les zones (0 inclus), + total. nil si vide.
  def present(zone_seconds, zones)
    total = zone_seconds.values.sum
    return nil if total <= 0

    list = zones.map do |z|
      secs = (zone_seconds[z[:key]] || 0.0)
      { zone: z[:key], seconds: secs.round, pct: (secs / total * 100).round(1) }
    end
    { total_seconds: total.round, zones: list }
  end
end
