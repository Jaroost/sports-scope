class PreferencesController < ApplicationController
  before_action :require_login!

  ALLOWED_STREAMS = %w[altitude heartrate velocity_smooth cadence watts temp grade_smooth].freeze
  MAX_GROUPS = 16
  MAX_STREAMS_PER_GROUP = 6
  MAX_NAME_LEN = 60

  # GET /preferences/chart_layouts
  def index
    layouts = current_user.chart_layouts.order(updated_at: :desc, name: :asc)
    render json: {
      chart_layouts: layouts.map { |l| serialize(l) },
      last_used_id: current_user.last_chart_layout_id,
    }
  end

  # POST /preferences/chart_layouts/last_used
  # Body: { id: <chart_layout id> } or { id: null } to clear.
  def set_last_used
    raw = params[:id]
    if raw.nil? || raw == "" || raw == "null"
      current_user.update!(last_chart_layout_id: nil)
    else
      record = current_user.chart_layouts.find_by(id: raw.to_i)
      return render json: { error: "not found" }, status: :not_found unless record
      current_user.update!(last_chart_layout_id: record.id)
    end
    head :no_content
  end

  # POST /preferences/chart_layouts
  # Upsert by name: if a layout already exists with the given name for the
  # current user, replace its `layout` body instead of erroring out.
  def create
    name = (params[:name] || "").to_s.strip
    return render json: { error: "name required" }, status: :unprocessable_entity if name.blank?
    return render json: { error: "name too long" }, status: :unprocessable_entity if name.length > MAX_NAME_LEN

    sanitized = sanitize_layout(params[:layout])
    record = current_user.chart_layouts.find_or_initialize_by(name: name)
    record.layout = sanitized
    record.save!
    render json: { chart_layout: serialize(record) }
  end

  # PATCH /preferences/chart_layouts/:id
  def update
    record = current_user.chart_layouts.find_by(id: params[:id])
    return render json: { error: "not found" }, status: :not_found unless record

    if params[:name].present?
      new_name = params[:name].to_s.strip
      record.name = new_name if new_name.length.between?(1, MAX_NAME_LEN)
    end
    record.layout = sanitize_layout(params[:layout]) if params.key?(:layout)
    record.save!
    render json: { chart_layout: serialize(record) }
  end

  # DELETE /preferences/chart_layouts/:id
  def destroy
    record = current_user.chart_layouts.find_by(id: params[:id])
    return render json: { error: "not found" }, status: :not_found unless record
    record.destroy
    head :no_content
  end

  private

  def serialize(record)
    { id: record.id, name: record.name, layout: record.layout || [] }
  end

  def sanitize_layout(raw)
    return [] unless raw.is_a?(Array)
    raw.take(MAX_GROUPS).map do |group|
      next nil unless group.is_a?(ActionController::Parameters) || group.is_a?(Hash)
      h = group.respond_to?(:to_unsafe_h) ? group.to_unsafe_h : group.with_indifferent_access
      id = (h["id"] || h[:id]).to_s
      streams = Array(h["streams"] || h[:streams]).map(&:to_s).select { |s| ALLOWED_STREAMS.include?(s) }
      next nil if streams.empty? || id.blank?
      collapsed = !!(h["collapsed"] || h[:collapsed])
      { "id" => id, "streams" => streams.uniq.take(MAX_STREAMS_PER_GROUP), "collapsed" => collapsed }
    end.compact
  end
end
