class AddLocalitiesToStravaActivities < ActiveRecord::Migration[8.1]
  def up
    enable_extension "pg_trgm" unless extension_enabled?("pg_trgm")

    # Nullable, sans défaut (contrairement à `routes.localities`) : NULL = « pas
    # encore extrait », `[]` = « extrait, aucune localité à proximité ». Le backfill
    # cible les NULL — avec un défaut `[]` il ne pourrait pas distinguer les deux et
    # réenfilerait indéfiniment les sorties en zone isolée à chaque tranche.
    add_column :strava_activities, :localities, :jsonb

    # Mêmes index qu'`AddLocalitiesToRoutes`, pour les mêmes raisons : la recherche
    # est un ILIKE '%…%' que seul un index trigram accélère, et Postgres n'utilise
    # les deux côtés d'un `name OR localities` (BitmapOr) que s'ils sont indexés
    # tous les deux.
    execute <<~SQL
      CREATE INDEX index_strava_activities_on_localities_trgm
        ON strava_activities USING gin ((localities::text) gin_trgm_ops)
    SQL

    execute <<~SQL
      CREATE INDEX index_strava_activities_on_name_trgm
        ON strava_activities USING gin (name gin_trgm_ops)
    SQL

    say "Lieux des activités existantes : lancer `ActivityLocalitiesBackfill.run!` " \
        "pour peupler `strava_activities.localities` (un appel Overpass par activité, " \
        "en tâche de fond)."
  end

  def down
    remove_index :strava_activities, name: "index_strava_activities_on_name_trgm"
    remove_index :strava_activities, name: "index_strava_activities_on_localities_trgm"
    remove_column :strava_activities, :localities
  end
end
