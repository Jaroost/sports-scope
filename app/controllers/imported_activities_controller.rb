class ImportedActivitiesController < ApplicationController
  before_action :require_login!

  MAX_STREAM_POINTS = 50_000
  ALLOWED_STREAM_KEYS = %w[time distance latlng altitude velocity_smooth heartrate cadence watts temp moving
                           grade_smooth].freeze

  # GET /api/imported_activities
  def index
    activities = current_user.imported_activities.order(started_at: :desc).limit(100)
    # TSS par sortie (charge d'entraînement) calculé en une passe, mêmes seuils que
    # la charge d'entraînement (FTP variable, LTHR).
    tss_map = TrainingLoad.tss_by_activity(current_user)
    render json: { activities: activities.map { |a| summary_json(a, tss: tss_map[['imported', a.id.to_s]]) } }
  end

  # GET /api/imported_activities/:id
  def show
    activity = current_user.imported_activities.find_by(id: params[:id])
    return head :not_found unless activity

    render json: { activity: summary_json(activity, tss: TrainingLoad.tss_for(current_user, 'imported', activity.id)) }
  end

  # GET /api/imported_activities/:id/streams
  def streams
    activity = current_user.imported_activities.find_by(id: params[:id])
    return head :not_found unless activity

    streams = activity.streams.is_a?(Hash) ? activity.streams : {}
    render json: { streams: streams }
  end

  # POST /api/imported_activities
  def create
    attrs = sanitize_attrs(params)
    return render json: { error: 'name required' }, status: :unprocessable_entity if attrs[:name].blank?

    activity = current_user.imported_activities.create!(attrs)
    activity.recompute_derivations!
    render json: { activity: summary_json(activity) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # GET /api/imported_activities/:id/peak_power_ranks
  # Returns the activity's stored peak_powers plus, for each duration, the
  # user's all-time best across BOTH imported and Strava activities (excluding
  # this activity itself) so the frontend can flag PRs.
  def peak_power_ranks
    activity = current_user.imported_activities.find_by(id: params[:id])
    return head :not_found unless activity

    # Lazy compute if missing — keeps older imports from showing nothing.
    activity.recompute_derivations! if activity.peak_powers.blank? && activity.streams.is_a?(Hash)
    render json: {
      current: activity.peak_powers,
      bests: PeakPowerCurve.bests_for_user(current_user, exclude: ['imported', activity.id])
    }
  end

  # GET /api/imported_activities/:id/zones
  # Répartition du temps par zone d'intensité (FC + puissance) pour cette sortie,
  # avec les seuils courants — même modèle que la page performance.
  def zones
    activity = current_user.imported_activities.find_by(id: params[:id])
    return head :not_found unless activity

    # Recalcule les dérivations (dont les histogrammes) si un import ancien ne les a pas.
    activity.recompute_derivations! if activity.hr_histogram.blank? && activity.power_histogram.blank? && activity.streams.is_a?(Hash)
    render json: TrainingLoad.zones_for_activity(current_user, activity)
  end

  # DELETE /api/imported_activities/:id
  def destroy
    activity = current_user.imported_activities.find_by(id: params[:id])
    return head :not_found unless activity

    activity.destroy
    head :no_content
  end

  private

  def summary_json(a, tss: nil)
    {
      id: a.id,
      source: a.source,
      tss: tss&.dig(:tss),
      tss_source: tss&.dig(:source),
      intensity_factor: tss&.dig(:intensity),
      normalized_power: a.normalized_power,
      filename: a.filename,
      name: a.name,
      type: a.activity_type,
      sport_type: a.activity_type,
      start_date: a.started_at&.iso8601,
      start_date_local: a.started_at&.iso8601,
      distance: a.distance_m,
      moving_time: a.moving_time_s,
      elapsed_time: a.elapsed_time_s,
      total_elevation_gain: a.total_elevation_gain,
      average_speed: a.average_speed,
      max_speed: a.max_speed,
      average_heartrate: a.average_heartrate,
      max_heartrate: a.max_heartrate,
      average_watts: a.average_watts,
      max_watts: a.max_watts,
      average_cadence: a.average_cadence,
      max_cadence: a.max_cadence,
      start_latlng: a.start_latlng,
      end_latlng: a.end_latlng,
      created_at: a.created_at.iso8601
    }
  end

  def sanitize_attrs(p)
    {
      source: p[:source].to_s.presence || 'fit',
      filename: p[:filename].to_s.first(255).presence,
      name: p[:name].to_s.strip.first(120).presence,
      activity_type: p[:activity_type].to_s.first(40).presence,
      started_at: parse_time(p[:started_at]),
      distance_m: numeric_or_nil(p[:distance_m]),
      moving_time_s: integer_or_nil(p[:moving_time_s]),
      elapsed_time_s: integer_or_nil(p[:elapsed_time_s]),
      total_elevation_gain: numeric_or_nil(p[:total_elevation_gain]),
      average_speed: numeric_or_nil(p[:average_speed]),
      max_speed: numeric_or_nil(p[:max_speed]),
      average_heartrate: numeric_or_nil(p[:average_heartrate]),
      max_heartrate: numeric_or_nil(p[:max_heartrate]),
      average_watts: numeric_or_nil(p[:average_watts]),
      max_watts: numeric_or_nil(p[:max_watts]),
      average_cadence: numeric_or_nil(p[:average_cadence]),
      max_cadence: numeric_or_nil(p[:max_cadence]),
      average_temp: numeric_or_nil(p[:average_temp]),
      start_latlng: latlng_or_nil(p[:start_latlng]),
      end_latlng: latlng_or_nil(p[:end_latlng]),
      streams: clean_streams(p[:streams])
    }
  end

  def clean_streams(raw)
    return {} unless raw.is_a?(ActionController::Parameters) || raw.is_a?(Hash)

    h = raw.respond_to?(:to_unsafe_h) ? raw.to_unsafe_h : raw
    out = {}
    h.each do |k, v|
      key = k.to_s
      next unless ALLOWED_STREAM_KEYS.include?(key)

      data = v.is_a?(Hash) ? (v['data'] || v[:data]) : v
      next unless data.is_a?(Array)

      out[key] = { 'data' => data.first(MAX_STREAM_POINTS) }
    end
    out
  end

  def parse_time(v)
    return nil if v.blank?

    Time.iso8601(v.to_s)
  rescue ArgumentError
    nil
  end

  def numeric_or_nil(v)
    return nil if v.nil? || v == ''

    f = v.to_f
    f.finite? ? f : nil
  end

  def integer_or_nil(v)
    return nil if v.nil? || v == ''

    v.to_i
  end

  def latlng_or_nil(v)
    return nil unless v.is_a?(Array) && v.length == 2

    lat = v[0].to_f
    lng = v[1].to_f
    return nil if lat.abs > 90 || lng.abs > 180

    [lat, lng]
  end
end
