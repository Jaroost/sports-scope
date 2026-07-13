# Recalcule les histogrammes FC / puissance (`hr_histogram`, `power_histogram`)
# manquants à partir des streams DÉJÀ stockés — aucun appel Strava. Idempotent :
# ne traite que les activités dont les deux histogrammes sont vides, et ne persiste
# que si la valeur change.
#
# Utile après l'ajout des colonnes d'histogrammes sur une base où les streams avaient
# déjà été récupérés (cf. NormalizedPowerBackfill pour la NP).
module ZoneHistogramBackfill
  module_function

  # Renvoie un rapport : { updated:, no_data:, no_streams:, scanned: }.
  #   • updated    — au moins un histogramme calculé et enregistré
  #   • no_data    — streams présents mais sans FC ni watts (histogrammes vides légitimes)
  #   • no_streams — streams jamais récupérés (rien à calculer)
  def call
    updated = 0
    no_data = 0
    no_streams = 0
    scanned = 0

    [StravaActivity, ImportedActivity].each do |klass|
      klass.where(hr_histogram: {}, power_histogram: {}).find_each do |activity|
        scanned += 1
        if activity.streams.blank?
          no_streams += 1
          next
        end

        if activity.compute_zone_histograms!
          updated += 1
        else
          no_data += 1
        end
      end
    end

    { updated: updated, no_data: no_data, no_streams: no_streams, scanned: scanned }
  end
end
