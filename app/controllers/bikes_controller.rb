# Suivi du cirage de chaîne (par vélo). Sert la liste des vélos + leurs chaînes avec
# les km parcourus depuis le dernier cirage. Les vélos viennent de Strava (gear) ;
# sans Strava, un vélo « par défaut » est créé automatiquement.
class BikesController < ApplicationController
  include BikeSerialization

  before_action :require_login!

  DEFAULT_BIKE_NAME = "Mon vélo".freeze

  # GET /api/bikes — bootstrap (sync gear / vélo par défaut) puis liste.
  # `?refresh=1` récupère d'abord les nouvelles activités Strava (les km des chaînes
  # en dépendent) ; `?refresh=gear` y ajoute un resync des vélos (cf. gear_sync_needed?).
  def index
    sync_strava_activities! if params[:refresh].present? && current_user.strava_linked?
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

  # POST /api/bikes/:id/chains — ajoute une chaîne au vélo.
  def add_chain
    bike = current_user.bikes.find_by(id: params[:id])
    return head :not_found unless bike

    bike.chains.create!(name: "Chaîne #{bike.chains.count + 1}")
    render json: { bike: serialize_bike(bike) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # POST /api/bikes/:id/mount — déclare quelle chaîne est désormais montée
  # (date par défaut = maintenant, ajustable au passé).
  def mount
    bike = current_user.bikes.find_by(id: params[:id])
    return head :not_found unless bike

    chain = bike.chains.find_by(id: params[:chain_id])
    return head :not_found unless chain

    mounted_at = parse_time(params[:mounted_at]) || Time.current
    return render json: { error: "future_date" }, status: :unprocessable_entity if mounted_at > 1.day.from_now

    bike.chain_mounts.create!(chain: chain, mounted_at: mounted_at)
    render json: { bike: serialize_bike(bike) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  private

  # Sync incrémental (les activités déjà stockées ne sont pas repaginées), sauf
  # premier passage où l'historique complet est nécessaire.
  def sync_strava_activities!
    StravaSyncService.new(current_user).call(full: current_user.strava_activities.none?)
  end

  def bootstrap_bikes!
    StravaGearSyncService.new(current_user).call if current_user.strava_linked? && gear_sync_needed?

    # Filet : aucun vélo (pas de Strava, ou Strava sans gear déclaré) → vélo par défaut.
    if current_user.bikes.none?
      current_user.bikes.create!(name: DEFAULT_BIKE_NAME, is_default: true).ensure_chain!
    end

    current_user.bikes.each(&:ensure_chain!)
  end

  # Un vélo n'apparaît ni ne change de nom souvent : on ne résout les `/gear/:id`
  # (une requête Strava par vélo) que quand une activité référence un `gear_id` pour
  # lequel on n'a pas encore créé de Bike (nouveau vélo). `?refresh=gear` force le
  # resync, seul moyen de rattraper un vélo renommé côté Strava.
  def gear_sync_needed?
    return true if params[:refresh].to_s == "gear"

    known = current_user.bikes.where.not(strava_gear_id: nil).pluck(:strava_gear_id)
    used = current_user.strava_activities.where.not(gear_id: nil).distinct.pluck(:gear_id)
    (used - known).any?
  end

  def make_default(bike)
    current_user.bikes.where.not(id: bike.id).update_all(is_default: false)
    bike.is_default = true
  end
end
