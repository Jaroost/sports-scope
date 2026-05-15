class ActivitiesController < ApplicationController
  before_action :require_login!

  def show
    @activity_id = params[:id]
    @strava_linked = current_user.strava_linked?
  end
end
