class AddLapsToImportedActivities < ActiveRecord::Migration[8.1]
  def change
    # Tours enregistrés par l'appareil, forme Strava (`start_index` / `end_index`
    # en indices de flux) pour que le front les traite comme ceux de Strava.
    add_column :imported_activities, :laps, :jsonb, default: [], null: false
  end
end
