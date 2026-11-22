# Profils de routage personnalisés de l'utilisateur (/api/routing_profiles).
class RoutingProfilesController < ApplicationController
  before_action :require_login!
  before_action :load_profile, only: %i[update destroy]

  def index
    render json: { routing_profiles: current_user.routing_profiles.order(:name).map { |p| serialize(p) } }
  end

  def create
    record = current_user.routing_profiles.new(permitted)
    save_and_render(record)
  end

  def update
    @profile.assign_attributes(permitted)
    save_and_render(@profile)
  end

  def destroy
    @profile.destroy
    head :no_content
  end

  private

  def load_profile
    @profile = current_user.routing_profiles.find_by(id: params[:id])
    render json: { error: "not found" }, status: :not_found unless @profile
  end

  def permitted
    params.permit(:name, :spec, :sport).tap { |p| p[:name] = p[:name].to_s.strip if p.key?(:name) }
  end

  def save_and_render(record)
    if record.save
      render json: { routing_profile: serialize(record) }
    else
      render json: { error: record.errors.full_messages.to_sentence }, status: :unprocessable_entity
    end
  end

  def serialize(record)
    { id: record.id, name: record.name, spec: record.spec, sport: record.sport }
  end
end
