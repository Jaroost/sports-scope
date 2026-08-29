# « Rafraîchir les activités » (POST /strava/refresh) est incrémental — quasi
# instantané. Mais l'incrémental ne voit jamais assez de l'historique pour
# distinguer une activité supprimée côté Strava d'une « pas encore récupérée » :
# seul un resync COMPLET (repagination de tout l'historique) élague les
# suppressions. On le fait donc périodiquement (cf. StravaRefreshService::
# FULL_SYNC_EVERY) plutôt qu'à chaque clic. Cette colonne retient quand le dernier
# full a tourné ; `nil` = jamais → le prochain refresh en fera un.
class AddStravaFullSyncedAtToUsers < ActiveRecord::Migration[8.1]
  def change
    add_column :users, :strava_full_synced_at, :datetime
  end
end
