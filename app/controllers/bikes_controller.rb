# Suivi d'usure du matériel (par vélo) : cirage de chaîne + usure des autres pièces
# (pneu, roue, pédalier, cassette, frein hydraulique, types custom). Sert la liste
# des vélos + leurs pièces avec les km parcourus. Les vélos viennent de Strava
# (gear) ; sans Strava, un vélo « par défaut » est créé automatiquement.
class BikesController < ApplicationController
  include BikeSerialization

  before_action :require_login!

  DEFAULT_BIKE_NAME = "Mon vélo".freeze

  # GET /api/bikes — bootstrap (sync gear / vélo par défaut) puis liste.
  # `?refresh=1` récupère d'abord les nouvelles activités Strava (les km des chaînes
  # en dépendent) ; `?refresh=gear` y ajoute un resync des vélos (cf. gear_sync_needed?).
  def index
    if params[:refresh].present? && current_user.strava_linked?
      refresh = StravaRefreshService.new(current_user)
      refresh.sync_summaries
      refresh.sync_gear(force: params[:refresh].to_s == "gear")
    end
    bootstrap_bikes!
    render json: { bikes: current_user.bikes.order(:id).map { |bike| serialize_bike(bike) } }
  rescue StravaGearSyncService::StravaApiError, StravaSyncService::StravaApiError => e
    render json: { error: e.message }, status: :bad_gateway
  end

  # PATCH /api/bikes/:id — renommer / désigner le vélo par défaut.
  def update
    bike = current_user.bikes.find_by(id: params[:id])
    return head :not_found unless bike

    bike.name = params[:name].to_s.strip.first(Bike::MAX_NAME_LEN) if params[:name].present?
    make_default(bike) if ActiveModel::Type::Boolean.new.cast(params[:is_default])
    bike.uses_wax = ActiveModel::Type::Boolean.new.cast(params[:uses_wax]) if params.key?(:uses_wax)
    bike.save!
    render json: { bike: serialize_bike(bike) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # DELETE /api/bikes/:id — supprime un vélo et ses chaînes. Si c'était le vélo
  # par défaut et qu'il en reste, on promeut le suivant pour que les km des imports
  # .fit / sorties Strava sans gear restent rattachés à un vélo.
  def destroy
    bike = current_user.bikes.find_by(id: params[:id])
    return head :not_found unless bike

    was_default = bike.is_default
    bike.destroy!
    if was_default
      next_default = current_user.bikes.order(:id).first
      next_default&.update!(is_default: true)
    end
    head :no_content
  end

  # POST /api/bikes/:id/parts — ajoute une pièce au vélo pour un type donné
  # (builtin ou custom de l'utilisateur).
  def add_part
    bike = current_user.bikes.find_by(id: params[:id])
    return head :not_found unless bike

    part_type = PartType.available_for(current_user).find_by(id: params[:part_type_id])
    return head :not_found unless part_type

    count = bike.parts.where(part_type: part_type).count
    default_name = part_type.builtin? ? "#{t("parts.types.#{part_type.key}")} #{count + 1}" : "#{part_type.name} #{count + 1}"
    name = params[:name].presence || default_name
    bike.parts.create!(
      name: name.to_s.strip.first(Part::MAX_NAME_LEN),
      part_type: part_type,
      wear_threshold_km: part_type.default_wear_threshold_km
    )
    render json: { bike: serialize_bike(bike) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # POST /api/bikes/:id/mount — déclare quelle pièce est désormais montée
  # (date par défaut = maintenant, ajustable au passé).
  def mount
    bike = current_user.bikes.find_by(id: params[:id])
    return head :not_found unless bike

    part = bike.parts.find_by(id: params[:part_id])
    return head :not_found unless part

    mounted_at = parse_time(params[:mounted_at]) || Time.current
    return render json: { error: "future_date" }, status: :unprocessable_entity if mounted_at > 1.day.from_now

    bike.part_mounts.create!(part: part, mounted_at: mounted_at)
    render json: { bike: serialize_bike(bike) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  private

  # Résout les vélos (gear) via l'orchestrateur — no-op si Strava non lié ou si
  # aucun nouveau gear n'est apparu — puis garantit un vélo par défaut + une chaîne.
  def bootstrap_bikes!
    StravaRefreshService.new(current_user).sync_gear

    # Filet : aucun vélo (pas de Strava, ou Strava sans gear déclaré) → vélo par défaut.
    if current_user.bikes.none?
      current_user.bikes.create!(name: DEFAULT_BIKE_NAME, is_default: true).ensure_chain!
    end

    current_user.bikes.each(&:ensure_chain!)
  end

  def make_default(bike)
    current_user.bikes.where.not(id: bike.id).update_all(is_default: false)
    bike.is_default = true
  end
end
