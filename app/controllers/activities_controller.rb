class ActivitiesController < ApplicationController
  before_action :require_login!

  def show
    @activity_id = params[:id]
    @strava_linked = current_user.strava_linked?
    @source = "strava"
    render :show
  end

  # Sortie d'un ami, en lecture seule. Le contrôle d'accès est fait par l'API
  # (FriendsController#activity) ; la page ne fait que monter l'îlot.
  def show_friend
    @activity_id = params[:id]
    @friend_id = params[:friend_id]
    @source = params[:source]
    render :show
  end

  def show_imported
    @activity_id = params[:id]
    @strava_linked = current_user.strava_linked?
    @source = "imported"
    render :show
  end
end
