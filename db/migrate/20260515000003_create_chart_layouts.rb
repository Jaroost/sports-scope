class CreateChartLayouts < ActiveRecord::Migration[8.1]
  def change
    create_table :chart_layouts do |t|
      t.references :user, null: false, foreign_key: true
      t.string :name, null: false
      t.jsonb :layout, null: false, default: []
      t.timestamps
    end
    add_index :chart_layouts, [:user_id, :name], unique: true
  end
end
