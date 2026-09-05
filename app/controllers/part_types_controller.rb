# Catalogue des types de pièce disponibles pour l'utilisateur courant : les types
# globaux (pneu, roue, pédalier, cassette, chaîne, frein hydraulique) + ses propres
# types custom. Un type global n'est jamais modifiable/supprimable ici.
class PartTypesController < ApplicationController
  before_action :require_login!

  # GET /api/part_types
  def index
    render json: { part_types: PartType.available_for(current_user).map { |pt| serialize_part_type(pt) } }
  end

  # POST /api/part_types — crée un type custom pour l'utilisateur courant.
  def create
    part_type = current_user.part_types.create!(
      name: params[:name].to_s.strip.first(PartType::MAX_NAME_LEN),
      default_wear_threshold_km: params[:default_wear_threshold_km].to_i
    )
    render json: { part_type: serialize_part_type(part_type) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # PATCH /api/part_types/:id — renommer / changer le seuil par défaut d'un type
  # custom. Les types globaux ne sont pas modifiables.
  def update
    part_type = current_user.part_types.find_by(id: params[:id])
    return head :not_found unless part_type

    part_type.name = params[:name].to_s.strip.first(PartType::MAX_NAME_LEN) if params[:name].present?
    part_type.default_wear_threshold_km = params[:default_wear_threshold_km].to_i if params.key?(:default_wear_threshold_km)
    part_type.save!
    render json: { part_type: serialize_part_type(part_type) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # DELETE /api/part_types/:id — refuse si encore utilisé par des pièces.
  def destroy
    part_type = current_user.part_types.find_by(id: params[:id])
    return head :not_found unless part_type
    return render json: { error: "in_use" }, status: :unprocessable_entity if part_type.parts.exists?

    part_type.destroy!
    head :no_content
  end

  private

  def serialize_part_type(part_type)
    {
      id: part_type.id,
      key: part_type.key,
      name: part_type.name,
      icon: part_type.icon,
      builtin: part_type.builtin?,
      default_wear_threshold_km: part_type.default_wear_threshold_km
    }
  end
end
