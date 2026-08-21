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
    render json: { training_programs: programs.map { |p| serialize_summary(p) } }
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
    copy = current_user.training_programs.create!(name: copy_name, milestones: src.milestones)
    render json: { training_program: serialize_full(copy) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  private

  def sanitize_attrs(p)
    out = {}
    out[:name] = p[:name].to_s.strip.first(MAX_NAME_LEN).presence if p.key?(:name)
    out[:milestones] = clean_milestones(p[:milestones]) if p.key?(:milestones)
    out
  end

  # Reconstruit la liste plutôt que de recopier ce qui est passé : chaque jalon est
  # borné puis retrié par offset_seconds — l'éditeur retrie déjà côté front (cf.
  # TrainingProgramBuilder.vue), mais le serveur ne fait jamais confiance à cet ordre.
  def clean_milestones(raw)
    return [] unless raw.is_a?(Array)
    cleaned = raw.take(TrainingProgram::MAX_MILESTONES).filter_map do |item|
      h = item.respond_to?(:to_unsafe_h) ? item.to_unsafe_h : item
      next unless h.is_a?(Hash)
      offset = h["offset_seconds"] || h[:offset_seconds]
      next unless offset.is_a?(Numeric) && offset >= 0
      sound = (h["sound"] || h[:sound]).presence
      sound = nil unless sound.nil? || TrainingProgram::SOUNDS.include?(sound.to_s)
      segment_name = (h["segment_name"] || h[:segment_name]).to_s.strip.first(TrainingProgram::MAX_SEGMENT_NAME_LEN)
      { "offset_seconds" => offset.to_i, "sound" => sound, "segment_name" => segment_name }
    end
    cleaned.sort_by { |m| m["offset_seconds"] }
  end

  def serialize_summary(program)
    {
      id: program.id,
      name: program.name,
      share_token: program.share_token,
      duration_seconds: program.duration_seconds,
      segment_count: Array(program.milestones).size,
      updated_at: program.updated_at.iso8601,
    }
  end

  def serialize_full(program)
    serialize_summary(program).merge(milestones: program.milestones || [])
  end
end
