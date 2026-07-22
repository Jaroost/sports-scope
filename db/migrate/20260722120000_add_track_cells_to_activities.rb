# Empreinte de trace d'une activité (`TrackFingerprint`) : la suite des cellules de
# grille traversées, avec le temps / la distance / l'index de stream à l'entrée de
# chacune. C'est ce qui permet de retrouver les portions de tracé communes entre
# deux sorties (analyse de segments) sans relire les streams de tout l'historique.
#
# Dérivée des streams comme les autres colonnes du registre `STREAM_DERIVATIONS` :
# `{}` tant que les streams ne sont pas récupérés, ou pour une activité sans GPS.
#
# L'index GIN porte sur les cellules grossières (~5 km) : c'est le préfiltre des
# candidats (`track_cells->'coarse' ?| array[...]`), une comparaison fine ne se fait
# que sur les activités passées quelque part dans la même zone.
class AddTrackCellsToActivities < ActiveRecord::Migration[8.1]
  def change
    add_column :strava_activities, :track_cells, :jsonb, default: {}, null: false
    add_column :imported_activities, :track_cells, :jsonb, default: {}, null: false

    add_index :strava_activities, "(track_cells -> 'coarse')",
              using: :gin, name: "index_strava_activities_on_track_coarse_cells"
    add_index :imported_activities, "(track_cells -> 'coarse')",
              using: :gin, name: "index_imported_activities_on_track_coarse_cells"
  end
end
