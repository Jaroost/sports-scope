# Les programmes d'entraînement passent de jalons (instants cumulés, un son par
# jalon) à des blocs (une durée, un son de début et/ou de fin chacun). Chaque jalon
# sauf le dernier devient un bloc dont la durée est l'écart au suivant ; le dernier
# jalon, qui n'ouvrait aucun tronçon, ne survit que par son son, devenu le son de fin
# du dernier bloc. Le nom, l'icône, les couleurs et les cibles portés par ce dernier
# jalon sont perdus : ils ne concernaient aucun bloc.
#
# Autonome (SQL + hash, pas de modèle) : le modèle a changé de forme depuis.
class ConvertTrainingProgramMilestonesToBlocks < ActiveRecord::Migration[8.1]
  BLOCK_KEYS = %w[segment_name icon color text_color].freeze
  TARGET_KEYS = %w[power heart_rate cadence speed_kmh].flat_map { |f| %w[target min max].map { |k| "#{k}_#{f}" } }.freeze

  def up
    add_column :training_programs, :blocks, :jsonb, default: [], null: false

    select_rows("SELECT id, milestones FROM training_programs").each do |id, raw|
      blocks = blocks_from(JSON.parse(raw))
      execute "UPDATE training_programs SET blocks = #{quote(blocks.to_json)}::jsonb WHERE id = #{id.to_i}"
    end

    remove_column :training_programs, :milestones
  end

  def down
    add_column :training_programs, :milestones, :jsonb, default: [], null: false

    select_rows("SELECT id, blocks FROM training_programs").each do |id, raw|
      execute "UPDATE training_programs SET milestones = #{quote(milestones_from(JSON.parse(raw)).to_json)}::jsonb WHERE id = #{id.to_i}"
    end

    remove_column :training_programs, :blocks
  end

  private

  def blocks_from(milestones)
    milestones = milestones.sort_by { |m| m["offset_seconds"].to_i }
    return [] if milestones.empty?

    # Un seul jalon : aucune durée à déduire, on en prête une au bloc qu'il aurait ouvert.
    return [block_from(milestones.first, 60, 0)] if milestones.size == 1

    blocks = milestones.each_cons(2).with_index.map do |(m, following), i|
      block_from(m, following["offset_seconds"].to_i - m["offset_seconds"].to_i, i)
    end
    closing = milestones.last
    if closing["sound"]
      blocks.last["end_sound"] = closing["sound"]
      blocks.last["end_cue_timing"] = closing["cue_timing"] || "before"
    end
    blocks
  end

  def block_from(milestone, duration, index)
    block = milestone.slice(*BLOCK_KEYS, *TARGET_KEYS).merge("duration_seconds" => [duration, 1].max)
    if milestone["sound"]
      block["start_sound"] = milestone["sound"]
      # Le jalon d'ouverture n'a rien avant lui : son son partait toujours au départ.
      block["start_cue_timing"] = index.zero? ? "at" : (milestone["cue_timing"] || "before")
    end
    block
  end

  def milestones_from(blocks)
    offset = 0
    milestones = blocks.map do |b|
      m = b.slice(*BLOCK_KEYS, *TARGET_KEYS).merge("offset_seconds" => offset, "sound" => b["start_sound"], "cue_timing" => b["start_cue_timing"])
      offset += b["duration_seconds"].to_i
      m
    end
    milestones << { "offset_seconds" => offset, "segment_name" => "", "sound" => blocks.last&.dig("end_sound"), "cue_timing" => blocks.last&.dig("end_cue_timing") }
  end
end
