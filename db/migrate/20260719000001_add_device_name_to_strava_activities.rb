class AddDeviceNameToStravaActivities < ActiveRecord::Migration[8.1]
  # Matériel d'enregistrement (« Garmin Edge 530 », « Strava iPhone App »…). Absent
  # des résumés Strava — il n'existe que dans l'activité détaillée. Rempli de façon
  # opportuniste à l'ouverture d'une activité et par le backfill dédié.
  #   • NULL  → jamais vérifié (détail pas encore récupéré) ;
  #   • ""     → vérifié, aucun appareil déclaré (saisie manuelle) — évite de le
  #              re-télécharger indéfiniment ;
  #   • valeur → nom de l'appareil.
  # Index partiel : le menu du filtre ne liste que les valeurs réellement présentes.
  def change
    add_column :strava_activities, :device_name, :string
    add_index :strava_activities, %i[user_id device_name],
              where: "device_name IS NOT NULL AND device_name <> ''",
              name: "index_strava_activities_on_user_id_and_device_name"
  end
end
