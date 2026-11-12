require "zlib"
require "stringio"
require "net/http"

# Envoie une activité importée vers Strava (`POST /api/v3/uploads`) puis suit le
# traitement (asynchrone côté Strava) via `GET /uploads/:id`. Le fichier est un TCX
# reconstruit depuis les streams (`TcxBuilder`), gzippé.
#
# Le scope `activity:write` est requis : l'utilisateur peut l'avoir refusé à
# l'autorisation (`User#strava_can_upload?`).
class StravaUploader
  URL = "https://www.strava.com/api/v3/uploads"

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

  # Types Strava acceptés tels quels dans `sport_type`.
  STRAVA_SPORT_TYPES = %w[Ride MountainBikeRide GravelRide EBikeRide Run TrailRun Walk Hike Swim
                          AlpineSki BackcountrySki NordicSki Snowboard VirtualRide].freeze

  def initialize(user)
    @user = user
  end

  # Premier appel : poste le fichier et retourne la réponse Strava (hash).
  def create(activity)
    builder = TcxBuilder.new(activity)
    raise ApiError.new(422, "no_track_data") unless builder.buildable?

    form = [
      ["file", StringIO.new(gzip(builder.to_xml)),
       { filename: "sports-scope-#{activity.id}.tcx.gz", content_type: "application/gzip" }],
      ["data_type", "tcx.gz"],
      ["name", activity.name.to_s],
      ["external_id", "sportsscope-#{activity.id}"]
    ]
    sport = strava_sport_type(activity.activity_type)
    form << ["sport_type", sport] if sport
    post_form(URL, form)
  end

  # Interroge l'état d'un upload en cours.
  def status(upload_id)
    uri = URI("#{URL}/#{upload_id}")
    handle(request(uri, Net::HTTP::Get.new(uri)))
  end

  private

  # Net::HTTP plutôt que Faraday : le multipart de Faraday 2 est une gem à part,
  # absente du projet, et `set_form` suffit pour un seul fichier.
  def post_form(url, form)
    uri = URI(url)
    req = Net::HTTP::Post.new(uri)
    req.set_form(form, "multipart/form-data")
    handle(request(uri, req))
  end

  def request(uri, req)
    req["Authorization"] = "Bearer #{@user.refresh_strava_token!}"
    Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 10, read_timeout: 60) { |http| http.request(req) }
  end

  def handle(response)
    body = JSON.parse(response.body.presence || "{}") rescue {}
    # Un 4xx avec un `error` (ex. doublon) est un résultat exploitable, pas une panne.
    return body if response.is_a?(Net::HTTPSuccess) || (response.code.to_i == 400 && body["error"].present?)

    Rails.logger.warn("[strava-upload] #{response.code}: #{response.body}")
    raise ApiError.new(response.code.to_i, "Strava API returned #{response.code}")
  end

  def gzip(data)
    io = StringIO.new
    gz = Zlib::GzipWriter.new(io)
    gz.write(data)
    gz.close
    io.string
  end

  def strava_sport_type(activity_type)
    return activity_type if STRAVA_SPORT_TYPES.include?(activity_type)

    case PerformanceRecords.effort_sport_category(activity_type)
    when "mtb" then "MountainBikeRide"
    when "gravel" then "GravelRide"
    when "cycling" then "Ride"
    when "running" then activity_type.to_s.downcase.include?("trail") ? "TrailRun" : "Run"
    when "hiking" then "Hike"
    when "swimming" then "Swim"
    end
  end
end
