# Gestion des pièces d'un vélo (usure, et cirage pour la chaîne) : seuil/nom,
# suppression. Toutes les actions sont scopées à l'utilisateur connecté via le
# vélo parent.
class PartsController < ApplicationController
  include BikeSerialization

  before_action :require_login!
  before_action :set_part

  # PATCH /api/parts/:id — renommer / changer le seuil d'usure / (chaîne
  # uniquement) changer le seuil de cirage ou marquer « à recirer ».
  def update
    @part.name = params[:name].to_s.strip.first(Part::MAX_NAME_LEN) if params[:name].present?
    @part.wear_threshold_km = params[:wear_threshold_km].to_i if params.key?(:wear_threshold_km)
    if @part.chain_part?
      @part.wax_threshold_km = params[:wax_threshold_km].to_i if params.key?(:wax_threshold_km)
      @part.needs_wax = ActiveModel::Type::Boolean.new.cast(params[:needs_wax]) if params.key?(:needs_wax)
    end
    @part.save!
    render json: { bike: serialize_bike(@part.bike) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # DELETE /api/parts/:id — refuse de supprimer la dernière chaîne du vélo (les
  # autres types sont un suivi optionnel, toujours supprimables).
  def destroy
    if @part.chain_part? && @part.bike.parts.joins(:part_type).where(part_types: { key: "chain" }).count <= 1
      return render json: { error: "cannot_delete_last" }, status: :unprocessable_entity
    end

    bike = @part.bike
    @part.destroy
    render json: { bike: serialize_bike(bike) }
  end

  # POST /api/parts/:id/wax — marque la chaîne cirée (date par défaut = aujourd'hui,
  # ajustable au passé). `scope: "bike"` cire toutes les chaînes du vélo en même
  # temps. Cirer une chaîne lève le drapeau « à recirer » posé manuellement.
  def wax
    return render json: { error: "not_a_chain" }, status: :unprocessable_entity unless @part.chain_part?

    waxed_at = parse_time(params[:waxed_at]) || Time.current
    return render json: { error: "future_date" }, status: :unprocessable_entity if waxed_at > 1.day.from_now

    chain_type_id = @part.part_type_id
    targets = params[:scope].to_s == "bike" ? @part.bike.parts.where(part_type_id: chain_type_id).to_a : [@part]
    targets.each { |chain| chain.update!(last_waxed_at: waxed_at, needs_wax: false) }
    render json: { bike: serialize_bike(@part.bike) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  private

  def set_part
    @part = Part.joins(:bike).where(bikes: { user_id: current_user.id }).find_by(id: params[:id])
    head :not_found unless @part
  end
end
