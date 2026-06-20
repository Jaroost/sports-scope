class AddRolesToUsers < ActiveRecord::Migration[8.1]
  def change
    add_column :users, :roles, :jsonb, default: [], null: false
  end
end
