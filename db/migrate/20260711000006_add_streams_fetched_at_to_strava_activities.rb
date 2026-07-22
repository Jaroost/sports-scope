# Marque quand les streams détaillés d'une activité Strava ont été récupérés
# depuis l'API. Sert de curseur au backfill de masse : on cible
# `streams_fetched_at IS NULL`, ce qui reste vrai tant qu'une activité n'a pas
# été tentée — et devient faux même pour une activité sans données de streams
# (réponse vide ou 404), évitant de boucler indéfiniment dessus.
class AddStreamsFetchedAtToStravaActivities < ActiveRecord::Migration[8.1]
  def up
    add_column :strava_activities, :streams_fetched_at, :datetime
    add_index :strava_activities, %i[user_id streams_fetched_at]

    # Les lignes qui portent déjà des streams (activités consultées avant ce
    # backfill) sont considérées comme récupérées : le backfill ne doit pas les
    # re-télécharger.
    execute(<<~SQL.squish)
      UPDATE strava_activities
         SET streams_fetched_at = updated_at
       WHERE streams <> '{}'::jsonb
    SQL
  end

  def down
    remove_column :strava_activities, :streams_fetched_at
  end
end
