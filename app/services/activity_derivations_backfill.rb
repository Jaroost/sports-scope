# Recalcule TOUTES les métriques dérivées des streams (`Activityable::STREAM_DERIVATIONS`
# — puissance normalisée, courbe de puissance, histogrammes FC/puissance…) à partir
# des streams DÉJÀ stockés. Aucun appel Strava.
#
# Point d'entrée unique de recalcul en masse : remplace les anciens backfills
# spécialisés (un par métrique). Idempotent — ne persiste que les lignes dont au
# moins une dérivée change. Utile après l'ajout d'une nouvelle dérivation au
# registre sur une base où les streams avaient déjà été récupérés (ex. prod).
module ActivityDerivationsBackfill
  module_function

  # Renvoie un rapport : { updated:, unchanged:, scanned: }.
  #   • updated   — au moins une dérivée recalculée et enregistrée
  #   • unchanged — déjà à jour (rien à écrire)
  #   • scanned   — lignes porteuses de streams examinées
  def call
    updated = 0
    unchanged = 0
    scanned = 0

    [StravaActivity, ImportedActivity].each do |klass|
      klass.with_streams.find_each do |activity|
        scanned += 1
        activity.recompute_derivations! ? (updated += 1) : (unchanged += 1)
      end
    end

    { updated: updated, unchanged: unchanged, scanned: scanned }
  end
end
