class TrainingProgramsController < ApplicationController
  # `shared` is public (token-based) so a deep-link opened from the companion app
  # works without an interactive session — same reasoning as RoutesController.
  before_action :require_login!, except: %i[shared]

  MAX_NAME_LEN = TrainingProgram::MAX_NAME_LEN

  # GET /api/training_programs
  # Pas de pagination serveur ni de carte d'ensemble (contrairement aux itinéraires) :
  # un programme n'a ni tracé ni géométrie à plafonner, et la liste reste courte.
  def index
    programs = current_user.training_programs.order(updated_at: :desc)
    render json: { training_programs: programs.map { |p| serialize_summary(p).merge(profile: serialize_profile(p)) } }
  end

  # GET /api/training_programs/:id
  def show
    program = current_user.training_programs.find_by(id: params[:id])
    return head :not_found unless program
    render json: { training_program: serialize_full(program) }
  end

  # GET /api/training_programs/shared/:token
  # Public, read-only lookup by unguessable token — powers the companion app
  # deep-link (?workout=<token>), symmetric to RoutesController#shared.
  def shared
    program = TrainingProgram.find_by(share_token: params[:token])
    return head :not_found unless program
    render json: { training_program: serialize_full(program) }
  end

  # POST /api/training_programs
  def create
    attrs = sanitize_attrs(params)
    return render json: { error: "name required" }, status: :unprocessable_entity if attrs[:name].blank?
    program = current_user.training_programs.create!(attrs)
    render json: { training_program: serialize_full(program) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # PATCH /api/training_programs/:id
  def update
    program = current_user.training_programs.find_by(id: params[:id])
    return head :not_found unless program
    program.update!(sanitize_attrs(params).compact)
    render json: { training_program: serialize_full(program) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # DELETE /api/training_programs/:id
  def destroy
    program = current_user.training_programs.find_by(id: params[:id])
    return head :not_found unless program
    program.destroy
    head :no_content
  end

  # POST /api/training_programs/:id/duplicate
  def duplicate
    src = current_user.training_programs.find_by(id: params[:id])
    return head :not_found unless src
    requested = params[:name].to_s.strip.first(MAX_NAME_LEN).presence
    copy_name = requested || "#{src.name} (copie)".first(MAX_NAME_LEN)
    copy = current_user.training_programs.create!(name: copy_name, sport: src.sport, items: src.items)
    render json: { training_program: serialize_full(copy) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  private

  def sanitize_attrs(p)
    out = {}
    out[:name] = p[:name].to_s.strip.first(MAX_NAME_LEN).presence if p.key?(:name)
    if p.key?(:sport)
      sport = p[:sport].to_s
      out[:sport] = TrainingProgram::SPORTS.include?(sport) ? sport : "cycling"
    end
    out[:items] = clean_items(p[:items]) if p.key?(:items)
    out
  end

  # Coerce une valeur en Float dans [0, ceiling], ou nil si absente/inexploitable —
  # la cohérence cible/bornes (ex: min <= target <= max) reste validée côté modèle.
  def clean_target(h, field, ceiling)
    value = h[field] || h[field.to_sym]
    return nil unless value.is_a?(Numeric) || (value.is_a?(String) && value.match?(/\A-?\d+(\.\d+)?\z/))
    Float(value).clamp(0, ceiling)
  rescue ArgumentError, TypeError
    nil
  end

  # Un son (`start_sound` / `end_sound`) et son moment (`*_cue_timing`) : le moment
  # n'est gardé que si le son l'est.
  def clean_sound(h, prefix, default_timing)
    sound = (h["#{prefix}_sound"] || h[:"#{prefix}_sound"]).presence&.to_s
    return { "#{prefix}_sound" => nil, "#{prefix}_cue_timing" => nil } unless TrainingProgram::SOUNDS.include?(sound)
    timing = (h["#{prefix}_cue_timing"] || h[:"#{prefix}_cue_timing"]).presence&.to_s
    timing = default_timing unless TrainingProgram::CUE_TIMINGS.include?(timing)
    { "#{prefix}_sound" => sound, "#{prefix}_cue_timing" => timing }
  end

  # Reconstruit la liste plutôt que de recopier ce qui est passé : chaque bloc est
  # borné, l'ordre reçu est conservé (c'est lui qui fait le programme). Un élément est
  # un bloc ou un groupe de répétition (`repeat` + `items`, imbriqué jusqu'à
  # MAX_GROUP_DEPTH niveaux ; au-delà le groupe est écarté). La cohérence d'ensemble —
  # plafond une fois déplié, chevauchement des sons — reste validée côté modèle.
  def clean_items(raw, depth = 0)
    return [] unless raw.is_a?(Array)
    raw.take(TrainingProgram::MAX_BLOCKS).filter_map do |item|
      h = item.respond_to?(:to_unsafe_h) ? item.to_unsafe_h : item
      next unless h.is_a?(Hash)
      repeat = h["repeat"] || h[:repeat]
      next clean_block(h) if repeat.nil?
      next if depth >= TrainingProgram::MAX_GROUP_DEPTH

      count = repeat.is_a?(Numeric) ? repeat.to_i : 0
      inner = clean_items(h["items"] || h[:items], depth + 1)
      next if inner.empty?
      { "repeat" => count.clamp(2, TrainingProgram::MAX_REPEAT), "items" => inner }
    end
  end

  # Un bloc optionnel peut être sauté depuis l'appli compagnon (échauffement…). La clé
  # n'est écrite que quand elle est vraie : absente = obligatoire, des deux côtés, donc un
  # document d'avant ce réglage — ou une appli plus ancienne que lui — ne saute rien.
  def optional_flag(h)
    ActiveModel::Type::Boolean.new.cast(h["optional"] || h[:optional]) ? { "optional" => true } : {}
  end

  def clean_block(h)
    return unless h.is_a?(Hash)
    duration = h["duration_seconds"] || h[:duration_seconds]
    return unless duration.is_a?(Numeric) && duration >= 1
    icon = (h["icon"] || h[:icon]).presence
    icon = nil unless icon.nil? || TrainingProgram::ICONS.include?(icon.to_s)
    color = (h["color"] || h[:color]).presence&.to_s&.strip&.downcase
    color = nil unless color.nil? || color.match?(TrainingProgram::HEX_COLOR)
    text_color = (h["text_color"] || h[:text_color]).presence&.to_s&.strip&.downcase
    text_color = nil unless text_color.nil? || text_color.match?(TrainingProgram::HEX_COLOR)
    segment_name = (h["segment_name"] || h[:segment_name]).to_s.strip.first(TrainingProgram::MAX_SEGMENT_NAME_LEN)
    description = (h["description"] || h[:description]).to_s.strip.first(TrainingProgram::MAX_DESCRIPTION_LEN)
    targets = TrainingProgram::TARGET_FIELDS.each_with_object({}) do |(field, ceiling), acc|
      acc["target_#{field}"] = clean_target(h, "target_#{field}", ceiling)
      acc["min_#{field}"] = clean_target(h, "min_#{field}", ceiling)
      acc["max_#{field}"] = clean_target(h, "max_#{field}", ceiling)
    end
    {
      "duration_seconds" => duration.to_i.clamp(1, TrainingProgram::MAX_BLOCK_SECONDS),
      "segment_name" => segment_name,
      "description" => description,
      "icon" => icon,
      "color" => color,
      "text_color" => text_color,
    }.merge(optional_flag(h))
     .merge(clean_sound(h, "start", TrainingProgram::DEFAULT_START_TIMING))
     .merge(clean_sound(h, "end", TrainingProgram::DEFAULT_END_TIMING))
     .merge(targets)
  end

  def serialize_summary(program)
    {
      id: program.id,
      name: program.name,
      sport: program.sport,
      share_token: program.share_token,
      duration_seconds: program.duration_seconds,
      segment_count: program.flat_blocks.size,
      updated_at: program.updated_at.iso8601,
    }
  end

  PROFILE_CHANNELS = %w[power heart_rate cadence speed_kmh].freeze

  # De quoi dessiner le profil d'un programme dans la liste : les blocs dépliés réduits à
  # leur durée et, pour chaque mesure ciblée quelque part dans le programme, à
  # `[cible, min, max]`, et à leur couleur. Les mesures jamais ciblées sont omises ; `nil` s'il n'y en a
  # aucune (rien à dessiner).
  def serialize_profile(program)
    blocks = program.flat_blocks
    channels = PROFILE_CHANNELS.select { |c| blocks.any? { |b| !b["target_#{c}"].nil? } }
    return nil if channels.empty?

    {
      channels: channels,
      steps: blocks.map do |b|
        { duration_seconds: b["duration_seconds"], color: b["color"] }.merge(channels.to_h { |c| [c, [b["target_#{c}"], b["min_#{c}"], b["max_#{c}"]]] })
      end,
    }
  end

  def serialize_full(program)
    # `items` : ce que l'éditeur modifie (blocs et groupes de répétition). `blocks` : les
    # mêmes, dépliés — ce que lit l'appli compagnon. `milestones` : le programme au format
    # d'avant les blocs, pour les versions de l'appli qui ne connaissent pas encore `blocks`.
    serialize_summary(program).merge(
      items: program.items || [],
      blocks: program.flat_blocks,
      milestones: program.legacy_milestones,
    )
  end
end
