class AddDiscardedAtToParts < ActiveRecord::Migration[8.1]
  def change
    add_column :parts, :discarded_at, :datetime
  end
end
