class CreateTrainingPrograms < ActiveRecord::Migration[8.1]
  def change
    create_table :training_programs do |t|
      t.references :user, null: false, foreign_key: true
      t.string :name, null: false
      # Jalons `[{ offset_seconds, sound, segment_name }, ...]`, triés par offset_seconds,
      # premier élément toujours à 0 (cf. TrainingProgram#validate_milestones).
      t.jsonb :milestones, null: false, default: []
      t.string :share_token, null: false
      t.timestamps
    end
    add_index :training_programs, [:user_id, :updated_at]
    add_index :training_programs, :share_token, unique: true
  end
end
