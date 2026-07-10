# Gestion des chaînes d'un vélo : seuil/nom, suppression, et cirage. Toutes les
# actions sont scopées à l'utilisateur connecté via le vélo parent.
class ChainsController < ApplicationController
  include BikeSerialization

  before_action :require_login!
  before_action :set_chain

  # PATCH /api/chains/:id — renommer / changer le seuil de km / marquer « à recirer ».
  def update
    @chain.name = params[:name].to_s.strip.first(Chain::MAX_NAME_LEN) if params[:name].present?
    @chain.wax_threshold_km = params[:wax_threshold_km].to_i if params.key?(:wax_threshold_km)
    @chain.needs_wax = ActiveModel::Type::Boolean.new.cast(params[:needs_wax]) if params.key?(:needs_wax)
    @chain.save!
    render json: { bike: serialize_bike(@chain.bike) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # DELETE /api/chains/:id — refuse de supprimer la dernière chaîne du vélo.
  def destroy
    if @chain.bike.chains.count <= 1
      return render json: { error: "cannot_delete_last" }, status: :unprocessable_entity
    end

    bike = @chain.bike
    @chain.destroy
    render json: { bike: serialize_bike(bike) }
  end

  # POST /api/chains/:id/wax — marque la chaîne cirée (date par défaut = aujourd'hui,
  # ajustable au passé). `scope: "bike"` cire toutes les chaînes du vélo en même temps.
  # Cirer une chaîne lève le drapeau « à recirer » posé manuellement.
  def wax
    waxed_at = parse_time(params[:waxed_at]) || Time.current
    return render json: { error: "future_date" }, status: :unprocessable_entity if waxed_at > 1.day.from_now

    targets = params[:scope].to_s == "bike" ? @chain.bike.chains.to_a : [@chain]
    targets.each { |chain| chain.update!(last_waxed_at: waxed_at, needs_wax: false) }
    render json: { bike: serialize_bike(@chain.bike) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  private

  def set_chain
    @chain = Chain.joins(:bike).where(bikes: { user_id: current_user.id }).find_by(id: params[:id])
    head :not_found unless @chain
  end
end
