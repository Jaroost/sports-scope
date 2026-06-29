class CreateBikes < ActiveRecord::Migration[8.1]
  def change
    create_table :bikes do |t|
      t.references :user, null: false, foreign_key: true
      t.string  :name, null: false
      t.string  :strava_gear_id        # nullable ; "b1234567" pour un vélo Strava
      t.boolean :is_default, null: false, default: false

      t.timestamps
    end
    add_index :bikes, [:user_id, :strava_gear_id], unique: true
  end
end
