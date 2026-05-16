class CreateRoutes < ActiveRecord::Migration[8.1]
  def change
    create_table :routes do |t|
      t.references :user, null: false, foreign_key: true
      t.string :name, null: false
      t.jsonb :waypoints, null: false, default: []
      t.jsonb :geometry, null: false, default: []
      t.float :distance_m
      t.float :elevation_gain_m
      t.float :elevation_loss_m
      t.string :profile, default: "cycling"
      t.timestamps
    end
    add_index :routes, [:user_id, :updated_at]
  end
end
