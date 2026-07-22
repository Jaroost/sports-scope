# Récupère l'activité détaillée Strava (`/activities/:id`) — seul endroit où figure
# le matériel d'enregistrement (`device_name`). Utilisé par le backfill device
# (`StravaDeviceBackfillJob`). Expose le rate-limit lu dans les headers de la
# dernière réponse pour que le backfill puisse se throttler, comme le fetcher de
# streams.
class StravaActivityDetailFetcher
  URL = "https://www.strava.com/api/v3/activities/%<id>s"

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

  # Récupère l'activité détaillée (hash). Lève `ApiError` sur échec.
  def fetch(strava_id)
    token = @user.refresh_strava_token!
    response = Faraday.get(
      format(URL, id: strava_id),
      {},
      { "Authorization" => "Bearer #{token}" }
    )
    @last_rate_limit = parse_rate_limit(response.headers)

    unless response.success?
      Rails.logger.warn("[strava-detail] GET #{strava_id} #{response.status}: #{response.body}")
      raise ApiError.new(response.status, "Strava API returned #{response.status}")
    end

    JSON.parse(response.body)
  end

  # Récupère le détail puis persiste `device_name` sur l'activité. Retourne le nom.
  def fetch_and_store_device!(activity)
    detail = fetch(activity.strava_id)
    activity.store_device_name!(detail)
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
