# Récupère les vélos (gear) de l'utilisateur depuis Strava et les upsert en `bikes`.
# Strava expose les vélos dans le profil détaillé (`GET /athlete` → `bikes:[{id,
# name, primary, ...}]`). On garde `last_waxed_at`/`wax_threshold_km` existants et on
# crée chaîne + montage initial pour tout nouveau vélo. Calqué sur StravaSyncService.
class StravaGearSyncService
  ATHLETE_URL = 'https://www.strava.com/api/v3/athlete'

  class StravaApiError < StandardError
    attr_reader :status

    def initialize(status, message)
      @status = status
      super(message)
    end
  end

  def initialize(user)
    @user = user
  end

  # Upsert les vélos de l'utilisateur. Renvoie le nombre de vélos.
  def call
    athlete = get(ATHLETE_URL)
    bikes = athlete.is_a?(Hash) ? Array(athlete['bikes'] || athlete[:bikes]) : []

    bikes.each { |b| upsert_bike(b) }

    ensure_a_default!
    @user.bikes.count
  end

  private

  def upsert_bike(b)
    gear_id = (b['id'] || b[:id]).to_s
    return if gear_id.blank?

    bike = @user.bikes.find_or_initialize_by(strava_gear_id: gear_id)
    bike.name = (b['name'] || b[:name]).to_s.strip.first(Bike::MAX_NAME_LEN).presence || 'Vélo'
    # Le vélo « primary » de Strava devient le vélo par défaut, sauf si l'utilisateur
    # en a déjà désigné un autre.
    bike.is_default = true if (b['primary'] || b[:primary]) && no_other_default?(bike)
    bike.save!
    bike.ensure_chain!
  end

  def no_other_default?(bike)
    @user.bikes.where(is_default: true).where.not(id: bike.id).none?
  end

  def ensure_a_default!
    return if @user.bikes.where(is_default: true).exists?

    @user.bikes.order(:id).first&.update!(is_default: true)
  end

  def get(url, params = {})
    token = @user.refresh_strava_token!
    response = Faraday.get(url, params, { 'Authorization' => "Bearer #{token}" })

    unless response.success?
      Rails.logger.warn("[strava-gear] GET #{url} #{response.status}: #{response.body}")
      raise StravaApiError.new(response.status, "Strava API returned #{response.status}")
    end

    JSON.parse(response.body)
  end
end
