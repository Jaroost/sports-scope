class AddAcceptedUturnsToRoutes < ActiveRecord::Migration[8.1]
  def change
    add_column :routes, :accepted_uturns, :jsonb, default: [], null: false
  end
end
