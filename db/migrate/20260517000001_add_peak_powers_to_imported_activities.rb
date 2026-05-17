class AddPeakPowersToImportedActivities < ActiveRecord::Migration[8.1]
  def change
    add_column :imported_activities, :peak_powers, :jsonb, null: false, default: {}
  end
end
