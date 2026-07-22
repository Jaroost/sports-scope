# Récupère les photos d'une activité Strava (`/activities/:id/photos`) et persiste
# les vignettes dans `strava_activities.photo_thumbs`, pour le carousel de la liste.
#
# Le résumé d'activité annonce combien de photos existent (`total_photo_count`) mais
# ne porte aucune URL : il faut une requête par activité, d'où le backfill de masse
# (`StravaPhotosBackfillJob`) plutôt qu'un appel au fil de l'affichage. Expose le
# rate-limit lu dans les headers de la dernière réponse, comme les autres fetchers.
class StravaPhotosFetcher
  URL = "https://www.strava.com/api/v3/activities/%<id>s/photos"
  # Taille demandée : la vignette de la liste fait ~36 px (jusqu'à ~110 px en écran
  # haute densité). 256 est la plus petite taille que Strava sert.
  THUMB_SIZE = 256

  class ApiError < StandardError
    attr_reader :status

    def initialize(status, message)
      @status = status
      super(message)
    end

    def rate_limited?
      status == 429
    end
  end

  # Usage/limites Strava, format « court,journalier » (fenêtre 15 min + quota du
  # jour). Valeurs éventuellement nil si les headers sont absents.
  RateLimit = Struct.new(:short_usage, :short_limit, :daily_usage, :daily_limit, keyword_init: true) do
    def short_remaining
      short_limit && short_usage ? short_limit - short_usage : nil
    end

    def daily_remaining
      daily_limit && daily_usage ? daily_limit - daily_usage : nil
    end
  end

  attr_reader :last_rate_limit

  def initialize(user)
    @user = user
  end

  # Récupère la liste des photos (tableau de hashes). Lève `ApiError` sur échec.
  def fetch(strava_id)
    token = @user.refresh_strava_token!
    response = Faraday.get(
      format(URL, id: strava_id),
      { size: THUMB_SIZE, photo_sources: true },
      { "Authorization" => "Bearer #{token}" }
    )
    @last_rate_limit = parse_rate_limit(response.headers)

    unless response.success?
      Rails.logger.warn("[strava-photos] GET #{strava_id} #{response.status}: #{response.body}")
      raise ApiError.new(response.status, "Strava API returned #{response.status}")
    end

    Array(JSON.parse(response.body))
  end

  # Récupère puis persiste les vignettes sur l'activité. Retourne les vignettes.
  def fetch_and_store!(activity)
    activity.store_photo_thumbs!(fetch(activity.strava_id))
  end

  private

  def parse_rate_limit(headers)
    limit = headers["x-readratelimit-limit"] || headers["x-ratelimit-limit"]
    usage = headers["x-readratelimit-usage"] || headers["x-ratelimit-usage"]
    short_l, daily_l = split_pair(limit)
    short_u, daily_u = split_pair(usage)
    RateLimit.new(short_usage: short_u, short_limit: short_l, daily_usage: daily_u, daily_limit: daily_l)
  end

  def split_pair(str)
    return [nil, nil] unless str

    a, b = str.to_s.split(",")
    [a&.strip&.to_i, b&.strip&.to_i]
  end
end
