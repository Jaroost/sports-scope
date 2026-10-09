class TrainingProgram < ApplicationRecord
  # Catalogue fermé : ce sont exactement les fichiers `assets/sounds/*.wav` du dépôt
  # companion (~/dev/sports-scope-companion) — aucun nouveau son n'est ajouté ici,
  # l'éditeur ne fait que choisir parmi ceux que l'appli sait déjà jouer.
  SOUNDS = %w[start end end2 end3 bell horn horn2 booster].freeze
  # Catalogue fermé — miroir de MILESTONE_ICONS (trainingProgramStore.ts). Purement
  # visuel côté éditeur pour l'instant, pas (encore) consommé par l'appli companion.
  ICONS = %w[warmup sprint effort recovery climb cooldown interval hydration alert finish].freeze
  # Le « moment » d'un son, relatif à la frontière qu'il accompagne (le début ou la fin
  # d'un bloc). `before` : le son démarre en avance pour se **terminer** pile sur la
  # frontière (WorkoutCuePolicy, dépôt companion). `at` : il **démarre** pile dessus.
  CUE_TIMINGS = %w[before at].freeze
  # Valeurs prises quand le document ne dit rien : un son de début joue dans le bloc
  # (`at`), un son de fin aussi (`before`, il se termine avec le bloc). Mêmes valeurs
  # côté éditeur et côté appli.
  DEFAULT_START_TIMING = "at"
  DEFAULT_END_TIMING = "before"
  # Durée de chaque son arrondie à la seconde supérieure — c'est la précision de
  # l'appli, qui compte en secondes entières (`WorkoutCuePolicy`). Miroir de
  # SOUND_SECONDS (trainingProgramStore.ts) ; durées réelles des `*.wav`.
  SOUND_SECONDS = {
    "start" => 5, "end" => 5, "end2" => 4, "end3" => 2,
    "bell" => 1, "horn" => 2, "horn2" => 5, "booster" => 7,
  }.freeze
  MAX_BLOCK_SECONDS = 24 * 3600
  HEX_COLOR = /\A#[0-9a-fA-F]{6}\z/
  MAX_NAME_LEN = 80
  MAX_SEGMENT_NAME_LEN = 60
  # Plafond du programme **déplié** (chaque répétition d'un groupe compte).
  MAX_BLOCKS = 200
  MAX_REPEAT = 99
  # Niveaux de groupes imbriqués : au-delà l'éditeur n'est plus lisible, et rien de
  # réaliste (séries de séries de répétitions) n'en demande davantage.
  MAX_GROUP_DEPTH = 3

  # Pilote seulement l'unité de saisie/affichage de la vitesse cible dans l'éditeur
  # (km/h vs allure min/km) — stockage toujours en km/h (target_speed_kmh & co),
  # quel que soit le sport. Cf. TrainingProgramBuilder.vue.
  SPORTS = %w[cycling running].freeze

  # Plafonds de sanité des cibles/bornes par jalon — larges, pas des zones physio.
  MAX_POWER_W = 3000
  MAX_HR_BPM = 250
  MAX_CADENCE_RPM = 220
  MAX_SPEED_KMH = 120
  # (nom du champ => plafond), utilisé pour valider les 4 canaux de la même façon.
  TARGET_FIELDS = {
    "power" => MAX_POWER_W,
    "heart_rate" => MAX_HR_BPM,
    "cadence" => MAX_CADENCE_RPM,
    "speed_kmh" => MAX_SPEED_KMH,
  }.freeze

  belongs_to :user
  # Unguessable token for the public shared lookup consumed by the companion app deep-link.
  has_secure_token :share_token

  validates :name, presence: true, length: { maximum: MAX_NAME_LEN }
  validates :sport, inclusion: { in: SPORTS }
  validates :items, presence: true
  validate :validate_items

  def self.group?(item)
    item.is_a?(Hash) && item.key?("repeat")
  end

  # Les blocs du programme **dépliés** : un groupe de répétition (`repeat` + `items`,
  # éventuellement imbriqué) est remplacé par ses éléments, répétés. C'est la forme
  # que lit l'appli compagnon (`blocks`) et sur laquelle portent les durées et les
  # contrôles de sons.
  def self.flatten_items(items)
    Array(items).flat_map do |item|
      next [item] unless group?(item)
      flatten_items(item["items"]) * item["repeat"].to_i
    end
  end

  def flat_blocks
    self.class.flatten_items(items)
  end

  # Durée totale du programme (s) : les blocs sont posés bout à bout.
  def duration_seconds
    flat_blocks.sum { |b| b.is_a?(Hash) ? b["duration_seconds"].to_i : 0 }
  end

  # Le document au format **jalons** (`offset_seconds` cumulé) que lisaient les
  # versions de l'appli compagnon d'avant les blocs. Servi à côté de `blocks` pour
  # qu'une appli plus ancienne que le site continue de dérouler le programme : le son
  # de début d'un bloc devient celui de son jalon, à défaut le son de fin du bloc
  # précédent (même frontière) ; un jalon de clôture porte le son de fin du dernier.
  def legacy_milestones
    offset = 0
    previous_end = nil
    milestones = flat_blocks.map do |b|
      start_sound = b["start_sound"]
      sound, timing = start_sound ? [start_sound, b["start_cue_timing"] || DEFAULT_START_TIMING] : previous_end
      milestone = b.except("duration_seconds", "start_sound", "start_cue_timing", "end_sound", "end_cue_timing")
                   .merge("offset_seconds" => offset, "sound" => sound, "cue_timing" => timing)
      offset += b["duration_seconds"].to_i
      previous_end = b["end_sound"] ? [b["end_sound"], b["end_cue_timing"] || DEFAULT_END_TIMING] : nil
      milestone
    end
    closing = { "offset_seconds" => offset, "segment_name" => "", "sound" => previous_end&.first, "cue_timing" => previous_end&.last }
    milestones << closing
  end

  # Les sons du programme, chacun avec l'intervalle qu'il occupe dans le temps
  # (secondes depuis le départ) : `[from, to, label]`. Sert à détecter les
  # chevauchements ; miroir de `soundSlots` (trainingProgramStore.ts).
  def self.sound_slots(blocks)
    offset = 0
    slots = []
    blocks.each_with_index do |b, i|
      finish = offset + b["duration_seconds"]
      if (sound = b["start_sound"])
        len = SOUND_SECONDS.fetch(sound)
        # Rien avant le premier bloc : son part au départ, quoi qu'on ait réglé.
        timing = i.zero? ? "at" : (b["start_cue_timing"] || DEFAULT_START_TIMING)
        from = timing == "before" ? offset - len : offset
        slots << [from, from + len, "block #{i + 1} start"]
      end
      if (sound = b["end_sound"])
        len = SOUND_SECONDS.fetch(sound)
        from = (b["end_cue_timing"] || DEFAULT_END_TIMING) == "at" ? finish : finish - len
        slots << [from, from + len, "block #{i + 1} end"]
      end
      offset = finish
    end
    slots
  end

  private

  # Les éléments sont un tableau jsonb libre : on valide sa forme ici plutôt que côté
  # contrôleur seul, pour qu'un enregistrement invalide ne puisse jamais être créé,
  # quel que soit le chemin d'écriture (console, tâche, contrôleur). Un élément est un
  # bloc, ou un groupe `{ "repeat" => n, "items" => [...] }` d'éléments (jusqu'à
  # MAX_GROUP_DEPTH niveaux).
  def validate_items
    return unless items.is_a?(Array)
    return if items.empty? # déjà signalé par `presence`

    total = count_blocks(items, 0)
    return if total.nil?
    if total > MAX_BLOCKS
      errors.add(:items, "at most #{MAX_BLOCKS} blocks once repeats are expanded")
      return
    end

    validate_blocks(flat_blocks)
  end

  # Le nombre de blocs une fois `list` déplié, ou `nil` (erreur ajoutée) si sa forme est
  # invalide. Calculé par arithmétique, sans rien déplier : un programme hostile
  # (99 × 99 × 99 répétitions) ne doit pas pouvoir allouer des millions de blocs.
  def count_blocks(list, depth)
    total = 0
    list.each do |item|
      unless item.is_a?(Hash)
        errors.add(:items, "each item must be an object")
        return nil
      end
      next total += 1 unless item.key?("repeat")

      inner = item["items"]
      unless item["repeat"].is_a?(Integer) && item["repeat"].between?(2, MAX_REPEAT) &&
             inner.is_a?(Array) && inner.any? && depth < MAX_GROUP_DEPTH
        errors.add(:items, "a repeat group needs a repeat count between 2 and #{MAX_REPEAT}, a non-empty list of items, and at most #{MAX_GROUP_DEPTH} nesting levels")
        return nil
      end
      inner_total = count_blocks(inner, depth + 1)
      return nil if inner_total.nil?
      total += item["repeat"] * inner_total
    end
    total
  end

  def validate_blocks(blocks)
    sounds_valid = true
    blocks.uniq.each do |b|
      unless b.is_a?(Hash) && b["duration_seconds"].is_a?(Integer) && b["duration_seconds"].between?(1, MAX_BLOCK_SECONDS)
        errors.add(:items, "each block needs an integer duration_seconds between 1 and #{MAX_BLOCK_SECONDS}")
        return
      end

      %w[start_sound end_sound].each do |key|
        sound = b[key]
        next if sound.nil? || SOUND_SECONDS.key?(sound)
        errors.add(:items, "#{key} must be one of #{SOUNDS.join(', ')}")
        sounds_valid = false
      end

      %w[start_cue_timing end_cue_timing].each do |key|
        timing = b[key]
        errors.add(:items, "#{key} must be one of #{CUE_TIMINGS.join(', ')}") unless timing.nil? || CUE_TIMINGS.include?(timing)
      end

      icon = b["icon"]
      errors.add(:items, "icon must be one of #{ICONS.join(', ')}") unless icon.nil? || ICONS.include?(icon)

      %w[color text_color].each do |key|
        value = b[key]
        errors.add(:items, "#{key} must be a #rrggbb hex value") unless value.nil? || value.match?(HEX_COLOR)
      end

      TARGET_FIELDS.each { |field, ceiling| validate_target_bounds(b, field, ceiling) }
    end

    validate_sounds_do_not_overlap(blocks) if sounds_valid
  end

  # Deux sons qui se joueraient en même temps s'écraseraient sur le téléphone : on
  # refuse le programme plutôt que de laisser l'un couper l'autre en pleine séance.
  # Se toucher (l'un finit pile quand l'autre commence) n'est pas se chevaucher.
  def validate_sounds_do_not_overlap(blocks)
    slots = self.class.sound_slots(blocks).sort_by { |from, to, _| [from, to] }
    errors.add(:items, "#{slots.first[2]} sound starts before the program begins") if slots.any? && slots.first[0] < 0
    slots.each_cons(2) do |a, b|
      errors.add(:items, "sounds overlap: #{a[2]} and #{b[2]}") if b[0] < a[1]
    end
  end

  # Une borne (min/max) n'a de sens qu'accompagnée d'une cible ; quand les deux bornes
  # sont là, la cible doit tomber entre elles. Chaque valeur présente doit être un
  # nombre non négatif sous son plafond de sanité (cf. TARGET_FIELDS).
  def validate_target_bounds(block, field, ceiling)
    target = block["target_#{field}"]
    min = block["min_#{field}"]
    max = block["max_#{field}"]

    [["target_#{field}", target], ["min_#{field}", min], ["max_#{field}", max]].each do |name, value|
      next if value.nil?
      unless value.is_a?(Numeric) && value >= 0 && value <= ceiling
        errors.add(:items, "#{name} must be a number between 0 and #{ceiling}")
      end
    end

    if (min || max) && target.nil?
      errors.add(:items, "min_#{field}/max_#{field} require target_#{field}")
    end
    if target && min && max && !(min..max).cover?(target)
      errors.add(:items, "target_#{field} must be between min_#{field} and max_#{field}")
    end
  end
end
