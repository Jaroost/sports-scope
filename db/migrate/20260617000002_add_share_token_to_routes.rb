class AddShareTokenToRoutes < ActiveRecord::Migration[8.1]
  def up
    add_column :routes, :share_token, :string

    # Backfill existing rows with a unique token (same format has_secure_token uses).
    Route.reset_column_information
    Route.where(share_token: nil).find_each do |route|
      route.update_columns(share_token: SecureRandom.base58(24))
    end

    change_column_null :routes, :share_token, false
    add_index :routes, :share_token, unique: true
  end

  def down
    remove_index :routes, :share_token
    remove_column :routes, :share_token
  end
end
