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
    require_login!
    @route_id = params[:id]
  end
end
