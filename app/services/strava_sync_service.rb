# Pulls a user's Strava activity *summaries* into `strava_activities`.
#
# - Full sync (default first run, or `full: true`): paginates the whole history.
# - Incremental sync: only fetches activities newer than the most recent one
#   already stored (via Strava's `after` epoch param), with a small overlap so
#   an activity saved exactly on the boundary isn't missed.
#
# Detailed streams are NOT fetched here — they're filled lazily on first view
# (see `StravaController#streams`) to stay within Strava's rate limit.
class StravaSyncService
  ACTIVITIES_URL = 'https://www.strava.com/api/v3/athlete/activities'
  PER_PAGE = 200
  MAX_PAGES = 100 # hard stop (~20k activities) so a bug can't loop forever
  OVERLAP = 1.hour # re-fetch a window before the newest stored activity

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

  # Returns the number of activity summaries created or updated.
  def call(full: false)
    after = full ? nil : incremental_after
    count = 0

    (1..MAX_PAGES).each do |page|
      params = { per_page: PER_PAGE, page: page }
      params[:after] = after.to_i if after

      batch = get(ACTIVITIES_URL, params)
      break if !batch.is_a?(Array) || batch.empty?

      batch.each do |summary|
        StravaActivity.upsert_summary(user: @user, summary: summary)
        count += 1
      end

      break if batch.length < PER_PAGE
    end

    count
  end

  private

  def incremental_after
    latest = @user.strava_activities.maximum(:started_at)
    return nil unless latest

    latest - OVERLAP
  end

  def get(url, params)
    token = @user.refresh_strava_token!
    response = Faraday.get(url, params, { 'Authorization' => "Bearer #{token}" })

    unless response.success?
      Rails.logger.warn("[strava-sync] GET #{url} #{response.status}: #{response.body}")
      raise StravaApiError.new(response.status, "Strava API returned #{response.status}")
    end

    JSON.parse(response.body)
  end
end
