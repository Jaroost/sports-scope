class PreferencesController < ApplicationController
  before_action :require_login!

  ALLOWED_STREAMS = %w[altitude heartrate velocity_smooth cadence watts temp grade_smooth].freeze
  MAX_GROUPS = 16
  MAX_STREAMS_PER_GROUP = 6

  def chart_layout
    render json: { chart_layout: current_user.chart_layout }
  end

  def update_chart_layout
    raw = request.parameters[:chart_layout]
    unless raw.is_a?(Array)
      return render json: { error: "chart_layout must be an array" }, status: :unprocessable_entity
    end

    sanitized = raw.take(MAX_GROUPS).map do |group|
      next nil unless group.is_a?(ActionController::Parameters) || group.is_a?(Hash)
      h = group.respond_to?(:to_unsafe_h) ? group.to_unsafe_h : group.with_indifferent_access
      id = (h["id"] || h[:id]).to_s
      streams = Array(h["streams"] || h[:streams]).map(&:to_s).select { |s| ALLOWED_STREAMS.include?(s) }
      next nil if streams.empty? || id.blank?
      collapsed = !!(h["collapsed"] || h[:collapsed])
      { "id" => id, "streams" => streams.uniq.take(MAX_STREAMS_PER_GROUP), "collapsed" => collapsed }
    end.compact

    current_user.update!(chart_layout: sanitized)
    render json: { chart_layout: current_user.chart_layout }
  end

  def reset_chart_layout
    current_user.update!(chart_layout: nil)
    render json: { chart_layout: nil }
  end
end
