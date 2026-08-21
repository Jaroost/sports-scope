class TrainingProgram < ApplicationRecord
  # Catalogue fermé : ce sont exactement les fichiers `assets/sounds/*.wav` du dépôt
  # companion (~/dev/sports-scope-companion) — aucun nouveau son n'est ajouté ici,
  # l'éditeur ne fait que choisir parmi ceux que l'appli sait déjà jouer.
  SOUNDS = %w[start end bell horn horn2 booster].freeze
  # Catalogue fermé — miroir de MILESTONE_ICONS (trainingProgramStore.ts). Purement
  # visuel côté éditeur pour l'instant, pas (encore) consommé par l'appli companion.
  ICONS = %w[warmup sprint effort recovery climb cooldown interval hydration alert finish].freeze
  # `before` (par défaut, absent inclus) : le son démarre en avance pour se terminer
  # pile au départ du jalon (WorkoutCuePolicy, dépôt companion). `at` : ancien
  # comportement, le son part au franchissement lui-même — utile pour un simple
  # repère qui n'a rien à annoncer à l'avance.
  CUE_TIMINGS = %w[before at].freeze
  HEX_COLOR = /\A#[0-9a-fA-F]{6}\z/
  MAX_NAME_LEN = 80
  MAX_SEGMENT_NAME_LEN = 60
  MAX_MILESTONES = 200

  belongs_to :user
  # Unguessable token for the public shared lookup consumed by the companion app deep-link.
  has_secure_token :share_token

  validates :name, presence: true, length: { maximum: MAX_NAME_LEN }
  validates :milestones, presence: true
  validate :validate_milestones

  # Durée totale du programme (s) — l'offset du dernier jalon, puisque la timeline
  # se termine avec lui (pas de tronçon après le dernier jalon).
  def duration_seconds
    Array(milestones).last&.dig("offset_seconds").to_i
  end

  private

  # Les jalons sont un tableau jsonb libre : on valide sa forme ici plutôt que côté
  # contrôleur seul, pour qu'un enregistrement invalide ne puisse jamais être créé,
  # quel que soit le chemin d'écriture (console, tâche, contrôleur).
  def validate_milestones
    return unless milestones.is_a?(Array)
    return if milestones.empty? # déjà signalé par `presence`

    if milestones.first["offset_seconds"] != 0
      errors.add(:milestones, "must start with a milestone at offset_seconds 0")
    end

    previous_offset = nil
    milestones.each do |m|
      unless m.is_a?(Hash) && m["offset_seconds"].is_a?(Integer) && m["offset_seconds"] >= 0
        errors.add(:milestones, "each milestone needs a non-negative integer offset_seconds")
        next
      end
      if previous_offset && m["offset_seconds"] <= previous_offset
        errors.add(:milestones, "offset_seconds must be strictly increasing")
      end
      previous_offset = m["offset_seconds"]

      sound = m["sound"]
      unless sound.nil? || TrainingProgram::SOUNDS.include?(sound)
        errors.add(:milestones, "sound must be one of #{TrainingProgram::SOUNDS.join(', ')}")
      end

      icon = m["icon"]
      unless icon.nil? || TrainingProgram::ICONS.include?(icon)
        errors.add(:milestones, "icon must be one of #{TrainingProgram::ICONS.join(', ')}")
      end

      cue_timing = m["cue_timing"]
      unless cue_timing.nil? || TrainingProgram::CUE_TIMINGS.include?(cue_timing)
        errors.add(:milestones, "cue_timing must be one of #{TrainingProgram::CUE_TIMINGS.join(', ')}")
      end

      color = m["color"]
      unless color.nil? || color.match?(HEX_COLOR)
        errors.add(:milestones, "color must be a #rrggbb hex value")
      end

      text_color = m["text_color"]
      unless text_color.nil? || text_color.match?(HEX_COLOR)
        errors.add(:milestones, "text_color must be a #rrggbb hex value")
      end
    end
  end
end
