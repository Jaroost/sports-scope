class AddKindToStravaBackfillRuns < ActiveRecord::Migration[8.1]
  # Distingue les runs de backfill : « streams » (téléchargement des streams, le
  # défaut historique) et « device » (récupération du matériel d'enregistrement via
  # l'activité détaillée). Le suivi de progression interroge le dernier run de la
  # bonne catégorie.
  def change
    add_column :strava_backfill_runs, :kind, :string, default: "streams", null: false
  end
end
