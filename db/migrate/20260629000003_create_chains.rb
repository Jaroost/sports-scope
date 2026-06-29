class CreateChains < ActiveRecord::Migration[8.1]
  def change
    create_table :chains do |t|
      t.references :bike, null: false, foreign_key: true
      t.string   :name, null: false                      # ex. "Chaîne 1"
      t.integer  :wax_threshold_km, null: false, default: 300
      t.datetime :last_waxed_at                            # nullable = jamais cirée

      t.timestamps
    end
  end
end
