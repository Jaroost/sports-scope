# Un groupe de répétition contient désormais des éléments (blocs ou groupes), plus
# seulement des blocs : sa clé `blocks` devient `items`, pour pouvoir imbriquer.
# Autonome (SQL + hash) : le modèle a changé de forme depuis.
class RenameTrainingProgramGroupBlocksToItems < ActiveRecord::Migration[8.1]
  def up
    select_rows("SELECT id, items FROM training_programs").each do |id, raw|
      items = rename(JSON.parse(raw))
      execute "UPDATE training_programs SET items = #{quote(items.to_json)}::jsonb WHERE id = #{id.to_i}"
    end
  end

  def down
    raise ActiveRecord::IrreversibleMigration
  end

  private

  def rename(list)
    list.map do |item|
      next item unless item.key?("repeat")
      { "repeat" => item["repeat"], "items" => rename(item["items"] || item["blocks"] || []) }
    end
  end
end
