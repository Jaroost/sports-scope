# Vignettes des photos Strava d'une activité, pour le carousel de la liste.
#
# NULL = jamais récupéré (cible du backfill) ; `[]` = récupéré, aucune photo
# exploitable. Le résumé Strava (`raw`) donne bien `total_photo_count`, mais aucune
# URL : celles-ci coûtent une requête `/activities/:id/photos` par activité, d'où
# le stockage (même logique que `streams` / `device_name`).
class AddPhotoThumbsToStravaActivities < ActiveRecord::Migration[8.1]
  def change
    add_column :strava_activities, :photo_thumbs, :jsonb
  end
end
