class AddNotesToParts < ActiveRecord::Migration[8.1]
  def change
    add_column :parts, :notes, :text
  end
end
