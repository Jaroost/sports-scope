class AddVoiceHintsToRoutes < ActiveRecord::Migration[8.1]
  def change
    add_column :routes, :voice_hints, :jsonb, default: [], null: false
  end
end
