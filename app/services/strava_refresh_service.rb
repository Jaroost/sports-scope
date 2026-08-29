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
# Et deux points d'entrée pour les boutons de l'accueil (POST /strava/refresh et
# POST /strava/recompute), séparés depuis que « Tout rafraîchir » est scindé :
#   • refresh_activities — resync des résumés + gear + (ré)enfile les backfills
#   • recompute_derivations — recalcul des stats & seuils (FTP, records, charge)
# Le bouton unique du tableau de bord (`StravaBackfill.vue`) enchaîne les deux
# appels côté front.
class StravaRefreshService
  # Cadence du resync COMPLET (repagination de tout l'historique). L'incrémental —
  # quasi instantané — ne voit jamais assez de l'historique pour distinguer une
  # activité supprimée côté Strava d'une « pas encore récupérée » : seul le full
  # élague les suppressions. On ne le paie donc qu'une fois par période, pas à
  # chaque clic (un full ~10 s vs. un incrémental ~0,3 s pour ~300 sorties). Une
  # suppression met au plus cette période à quitter le miroir local ; le bouton
  # « Tout rafraîchir » du tableau de bord (`force_full:`) en force un tout de suite.
  FULL_SYNC_EVERY = 7.days

  def initialize(user)
    @user = user
  end

  # « Rafraîchir les activités » : resync des résumés (incrémental, sauf full dû —
  # cf. FULL_SYNC_EVERY — qui élague en plus les activités supprimées côté Strava),
  # gear, puis (ré)enfile les backfills de masse (streams / matériel / photos). NE
  # recalcule PAS les dérivées : c'est le rôle de `recompute_derivations`, déclenché
  # séparément. Note : quand le full tourne, l'élagage d'une activité supprimée
  # bouge `UserActivities.data_version` (COUNT), donc les caches FTP / records /
  # charge s'invalident naturellement ; ce que `recompute_derivations` ajoute, c'est
  # le recalcul des métriques issues des streams déjà stockés.
  # `force_full:` — repagine tout maintenant quoi qu'il arrive.
  # Renvoie un rapport { synced:, run:, device_run: }.
  def refresh_activities(force_full: false)
    synced = sync_summaries(full: force_full || full_sync_due?)
    sync_gear
    device_run = enqueue_device_backfill
    enqueue_photos_backfill
    { synced: synced, run: enqueue_streams_backfill, device_run: device_run }
  end

  # Recalcule les métriques dérivées des streams (`Activityable::STREAM_DERIVATIONS`)
  # pour les seules activités de l'utilisateur, à partir des streams DÉJÀ stockés
  # (aucun appel Strava). Local et rapide (~5 s pour ~300 sorties) : inline plutôt
  # qu'en job, contrairement aux backfills qui, eux, tapent l'API Strava. Renvoie
  # le nombre d'activités dont au moins une dérivée a changé.
  def recompute_derivations
    ActivityDerivationsBackfill.call(user: @user)[:updated]
  end

  # Résumés d'activités. `full` : true = repagine tout l'historique, false =
  # incrémental. Par défaut, full uniquement au tout premier passage (table vide).
  # Quand un full tourne, on horodate `strava_full_synced_at` : c'est ce que lit
  # `full_sync_due?` pour espacer les full de `refresh_activities`.
  # Renvoie le nombre de résumés créés/mis à jour.
  def sync_summaries(full: nil)
    full = @user.strava_activities.none? if full.nil?
    count = StravaSyncService.new(@user).call(full: full)
    @user.update_column(:strava_full_synced_at, Time.current) if full
    count
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

  # (Ré)enfile la récupération des vignettes photo des activités qui en annoncent
  # (`total_photo_count`) sans qu'on ait leurs URLs. Idempotent : réutilise un run
  # photos actif, n'enfile un job que si rien ne tourne déjà. Renvoie le run, ou nil
  # si rien à récupérer / Strava non lié.
  def enqueue_photos_backfill
    return nil unless @user.strava_linked?

    pending = @user.strava_activities.photos_pending.count

    run = @user.strava_backfill_runs.photos.active.order(created_at: :desc).first
    if run.nil?
      return nil if pending.zero?

      run = @user.strava_backfill_runs.create!(kind: "photos", status: "pending", total: pending)
      StravaPhotosBackfillJob.perform_later(run.id)
    elsif run.resumable?
      StravaPhotosBackfillJob.perform_later(run.id)
    end

    run
  end

  private

  # Un full est dû si on n'en a jamais fait (`strava_full_synced_at` nil — inclut
  # le tout premier passage, table vide) ou si le dernier remonte à plus de
  # `FULL_SYNC_EVERY`.
  def full_sync_due?
    last = @user.strava_full_synced_at
    last.nil? || last < FULL_SYNC_EVERY.ago
  end

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
