# Point d'entrée UNIQUE de la récupération des données Strava d'un utilisateur.
# Centralise le « quand syncer quoi », logique auparavant dupliquée dans
# `StravaController` et `BikesController` (chacun décidait full/incrémental,
# quand resync le gear, etc.).
#
# Trois briques, composables :
#   • sync_summaries — résumés d'activités (full au 1er passage, incrémental ensuite)
#   • sync_gear      — vélos (gear) quand une activité référence un vélo inconnu
#   • enqueue_streams_backfill — téléchargement de masse des streams manquants (job)
#
# Et un raccourci `refresh_all` = « Tout rafraîchir » : enchaîne les trois.
class StravaRefreshService
  def initialize(user)
    @user = user
  end

  # « Tout rafraîchir » : résumés récents + gear + (ré)enfile le backfill des
  # streams manquants. Renvoie un rapport { synced:, run: } (run = StravaBackfillRun
  # ou nil si rien à télécharger).
  def refresh_all
    synced = sync_summaries
    sync_gear
    device_run = enqueue_device_backfill
    { synced: synced, run: enqueue_streams_backfill, device_run: device_run }
  end

  # Résumés d'activités. `full` : true = repagine tout l'historique, false =
  # incrémental. Par défaut, full uniquement au tout premier passage (table vide).
  # Renvoie le nombre de résumés créés/mis à jour.
  def sync_summaries(full: nil)
    full = @user.strava_activities.none? if full.nil?
    StravaSyncService.new(@user).call(full: full)
  end

  # Résout les vélos Strava (gear) en base. `force: true` resync systématiquement ;
  # sinon seulement quand une activité référence un `gear_id` sans Bike associé
  # (nouveau vélo). No-op si Strava non lié. Renvoie le nombre de vélos.
  def sync_gear(force: false)
    return 0 unless @user.strava_linked?
    return @user.bikes.count unless force || gear_sync_needed?

    StravaGearSyncService.new(@user).call
  end

  # (Ré)enfile le téléchargement de masse des streams manquants. Idempotent :
  # réutilise un run actif s'il y en a un, n'enfile un job que si rien ne tourne
  # déjà. Renvoie le StravaBackfillRun courant, ou nil si aucun stream à récupérer.
  def enqueue_streams_backfill
    pending = @user.strava_activities.streams_pending.count

    run = @user.strava_backfill_runs.streams.active.order(created_at: :desc).first
    if run.nil?
      return nil if pending.zero?

      run = @user.strava_backfill_runs.create!(kind: 'streams', status: 'pending', total: pending)
      StravaStreamsBackfillJob.perform_later(run.id)
    elsif run.resumable?
      StravaStreamsBackfillJob.perform_later(run.id)
    end

    run
  end

  # (Ré)enfile la récupération du matériel d'enregistrement (`device_name`) des
  # activités jamais vérifiées, via l'activité détaillée. Idempotent : réutilise un
  # run device actif, n'enfile un job que si rien ne tourne déjà. Renvoie le run, ou
  # nil si rien à récupérer / Strava non lié.
  def enqueue_device_backfill
    return nil unless @user.strava_linked?

    pending = @user.strava_activities.device_unchecked.count

    run = @user.strava_backfill_runs.device.active.order(created_at: :desc).first
    if run.nil?
      return nil if pending.zero?

      run = @user.strava_backfill_runs.create!(kind: "device", status: "pending", total: pending)
      StravaDeviceBackfillJob.perform_later(run.id)
    elsif run.resumable?
      StravaDeviceBackfillJob.perform_later(run.id)
    end

    run
  end

  private

  # Un matériel n'apparaît ni ne change de nom souvent : on ne résout les `/gear/:id`
  # (une requête Strava par matériel) que quand une activité référence un `gear_id`
  # (vélo ou chaussure) pour lequel on n'a pas encore de nom en base.
  def gear_sync_needed?
    known_bikes = @user.bikes.where.not(strava_gear_id: nil).pluck(:strava_gear_id)
    used_bikes = @user.strava_activities.with_bike_gear.distinct.pluck(:gear_id)
    return true if (used_bikes - known_bikes).any?

    known_shoes = @user.strava_gears.pluck(:gear_id)
    used_shoes = @user.strava_activities.with_shoe_gear.distinct.pluck(:gear_id)
    (used_shoes - known_shoes).any?
  end
end
