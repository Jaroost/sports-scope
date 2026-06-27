class AddPoisToRoutes < ActiveRecord::Migration[8.1]
  def change
    add_column :routes, :pois, :jsonb, default: [], null: false
  end
end
