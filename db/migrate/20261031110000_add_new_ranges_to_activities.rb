class AddNewRangesToActivities < ActiveRecord::Migration[8.1]
  def change
    # Plages d'indices de stream [[début, fin], …] qui passent sur de nouvelles routes
    # (cf. `ExploredDistance`) : de quoi les surligner sur la carte de l'activité.
    add_column :strava_activities, :new_ranges, :jsonb
    add_column :imported_activities, :new_ranges, :jsonb
  end
end
