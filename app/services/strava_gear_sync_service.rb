# Crée/maj les vélos (`bikes`) de l'utilisateur à partir de ses gear Strava.
#
# Le scope OAuth de l'app (`read,activity:read_all`) ne donne PAS accès à la liste
# des vélos du profil (`GET /athlete` → `bikes` vide, nécessiterait `profile:read_all`).
# En revanche `GET /gear/:id` fonctionne avec ce scope et renvoie le nom du vélo.
# On découvre donc les vélos via les `gear_id` déjà présents dans les activités
# (colonne `strava_activities.gear_id`) puis on résout chaque nom via `/gear/:id`.
#
# On conserve `last_waxed_at`/`wax_threshold_km` existants et on crée chaîne +
# montage initial pour tout nouveau vélo. Calqué sur StravaSyncService.
class StravaGearSyncService
  GEAR_URL = 'https://www.strava.com/api/v3/gear'

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

  # Upsert les vélos (table `bikes`) et les chaussures (table `strava_gears`) de
  # l'utilisateur à partir des `gear_id` référencés par ses activités. Renvoie le
  # nombre de vélos.
  def call
    bike_ids = @user.strava_activities.with_bike_gear.distinct.pluck(:gear_id)
    bike_ids.each { |gear_id| upsert_bike(gear_id) }
    ensure_a_default!

    shoe_ids = @user.strava_activities.with_shoe_gear.distinct.pluck(:gear_id)
    shoe_ids.each { |gear_id| upsert_shoe(gear_id) }

    @user.bikes.count
  end

  private

  # Chaussure : simple cache de nom pour le filtre (pas de chaînes / cirage). On ne
  # re-résout que les gear inconnus — le nom d'une chaussure ne change guère.
  def upsert_shoe(gear_id)
    return if @user.strava_gears.exists?(gear_id: gear_id)

    gear = fetch_gear(gear_id)
    name = gear && (gear["nickname"].presence || gear["name"].presence)
    return if name.blank? # gear illisible : on réessaiera au prochain sync

    @user.strava_gears.create!(gear_id: gear_id, gear_type: "shoe", name: name.to_s.strip.first(255))
  end

  def upsert_bike(gear_id)
    gear = fetch_gear(gear_id)
    bike = @user.bikes.find_or_initialize_by(strava_gear_id: gear_id)
    bike.name = gear_name(gear, gear_id)
    # Le vélo « primary » de Strava devient le vélo par défaut, sauf si l'utilisateur
    # en a déjà désigné un autre.
    bike.is_default = true if gear && gear['primary'] && no_other_default?(bike)
    bike.save!
    bike.ensure_chain!
  end

  def fetch_gear(gear_id)
    get("#{GEAR_URL}/#{gear_id}")
  rescue StravaApiError => e
    Rails.logger.warn("[strava-gear] gear #{gear_id} unreadable: #{e.message}")
    nil
  end

  def gear_name(gear, gear_id)
    name = gear && (gear['nickname'].presence || gear['name'].presence)
    (name || "Vélo #{gear_id}").to_s.strip.first(Bike::MAX_NAME_LEN)
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
