class PagesController < ApplicationController
  def home
  end

  def dashboard
    require_login!
  end

  def routes_index
    require_login!
  end

  def route_builder
    require_login!
    @route_id = params[:id]
  end

  def route_navigation
    # No login required: navigation links are addressed by share_token and can
    # be shared with anyone.
    @share_token = params[:token]
  end

  def route_view
    # No login required: read-only builder view addressed by share_token, meant
    # to be shared with anyone (signed-out recipients included).
    @share_token = params[:token]
  end
end
