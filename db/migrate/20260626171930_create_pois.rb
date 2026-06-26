class CreatePois < ActiveRecord::Migration[8.1]
  def change
    create_table :pois do |t|
      t.references :user, null: false, foreign_key: true
      t.string :name, null: false
      t.string :category, null: false
      t.float :lat, null: false
      t.float :lng, null: false
      t.string :source, null: false, default: "custom"

      t.timestamps
    end
  end
end
