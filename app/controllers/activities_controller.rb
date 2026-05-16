class ActivitiesController < ApplicationController
  before_action :require_login!

  def show
    @activity_id = params[:id]
    @strava_linked = current_user.strava_linked?
    @source = "strava"
    render :show
  end

  def show_imported
    @activity_id = params[:id]
    @strava_linked = current_user.strava_linked?
    @source = "imported"
    render :show
  end
end
