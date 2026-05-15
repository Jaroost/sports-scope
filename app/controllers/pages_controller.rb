class PagesController < ApplicationController
  def home
  end

  def dashboard
    require_login!
  end
end
