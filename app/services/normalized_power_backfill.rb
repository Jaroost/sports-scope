# Recalcule la puissance normalisée (`normalized_power`) manquante à partir des
# streams DÉJÀ stockés — aucun appel Strava. Idempotent : ne touche que les
# activités dont la NP est NULL, et ne persiste que si la valeur change.
#
# Utile après l'ajout de la colonne `normalized_power` sur une base où les streams
# avaient été récupérés avant l'existence du calcul de NP (ex. prod). Sans NP, ces
# sorties retombent sur le TSS estimé/FC et gonflent le CTL/ATL.
module NormalizedPowerBackfill
  module_function

  # Renvoie un rapport : { updated:, no_power:, no_streams:, scanned: }.
  #   • updated    — NP effectivement calculée et enregistrée
  #   • no_power   — streams présents mais sans watts (NP NULL légitime)
  #   • no_streams — streams jamais récupérés (rien à calculer)
  def call
    updated = 0
    no_power = 0
    no_streams = 0
    scanned = 0

    [StravaActivity, ImportedActivity].each do |klass|
      klass.where(normalized_power: nil).find_each do |activity|
        scanned += 1
        if activity.streams.blank?
          no_streams += 1
          next
        end

        if activity.compute_normalized_power!
          updated += 1
        else
          no_power += 1
        end
      end
    end

    { updated: updated, no_power: no_power, no_streams: no_streams, scanned: scanned }
  end
end
