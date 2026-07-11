# Télécharge en masse les streams manquants des activités Strava d'un utilisateur,
# en respectant le rate limit Strava (~1 requête par activité). Traite un lot puis
# se ré-enfile : le run reste résumable même sans queue durable (adapter `async`),
# puisqu'on ne cible que les activités `streams_pending`.
class StravaStreamsBackfillJob < ApplicationJob
  queue_as :default

  BATCH = 50                 # activités par invocation avant de se ré-enfiler
  SHORT_WINDOW_MARGIN = 5    # on s'arrête quand il reste si peu de requêtes dans la fenêtre 15 min
  RATE_WINDOW = 15.minutes   # fenêtre courte Strava

  def perform(run_id)
    run = StravaBackfillRun.find_by(id: run_id)
    return if run.nil? || run.status == "completed"

    user = run.user
    fetcher = StravaStreamsFetcher.new(user)
    run.update!(status: "running", rate_limited_until: nil)

    pending = user.strava_activities.streams_pending.order(started_at: :desc)
    return run.update!(status: "completed") if pending.none?

    pending.limit(BATCH).each do |activity|
      begin
        fetcher.fetch_and_store!(activity)
      rescue StravaStreamsFetcher::ApiError => e
        return reschedule(run, e) if e.rate_limited?

        # 404 / autre : pas de streams exploitables pour cette activité. On la
        # marque récupérée pour ne pas boucler dessus, et on note l'erreur.
        activity.update_column(:streams_fetched_at, Time.current)
        run.update_column(:last_error, "#{activity.strava_id}: #{e.message}")
      end

      rl = fetcher.last_rate_limit
      return reschedule(run) if rl&.short_remaining && rl.short_remaining <= SHORT_WINDOW_MARGIN
    end

    if user.strava_activities.streams_pending.exists?
      self.class.set(wait: 2.seconds).perform_later(run.id)
    else
      run.update!(status: "completed")
    end
  rescue StandardError => e
    run&.update(status: "failed", last_error: e.message)
    raise
  end

  private

  # Passe le run en rate_limited et planifie la reprise au début de la prochaine
  # fenêtre 15 min (l'adapter async honore `wait`).
  def reschedule(run, error = nil)
    wait = seconds_until_next_window
    run.update!(
      status: "rate_limited",
      rate_limited_until: Time.current + wait,
      last_error: error&.message || run.last_error
    )
    self.class.set(wait: (wait + 5).seconds).perform_later(run.id)
  end

  def seconds_until_next_window
    window = RATE_WINDOW.to_i
    window - (Time.current.to_i % window)
  end
end
