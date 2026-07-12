# Puissance normalisée (NP) pré-calculée par activité : intrinsèque à la sortie
# (indépendante des seuils de l'athlète), donc stockée. Le TSS, lui, se calcule à la
# lecture car il dépend de la FTP (modifiable). NULL = pas de données de puissance.
class AddNormalizedPowerToActivities < ActiveRecord::Migration[8.1]
  def change
    add_column :strava_activities, :normalized_power, :float
    add_column :imported_activities, :normalized_power, :float
  end
end
