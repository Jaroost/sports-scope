# Empreintes de trace (`track_cells`) alimentant l'analyse de segments. Elles sont
# posées automatiquement à l'écriture des streams ; cette tâche sert à rattraper
# l'historique déjà téléchargé (après la migration, ou après un changement de
# `TrackFingerprint`).
#
#   bin/rails segments:backfill   # (re)calcule les dérivées manquantes
#   bin/rails segments:pending    # combien d'activités ont des streams sans empreinte
#
# Le calcul passe par `ActivityDerivationsBackfill`, qui recalcule TOUTES les
# dérivées des streams (puissance, histogrammes, empreinte) et n'écrit que les
# lignes qui changent.
namespace :segments do
  desc "Calcule les empreintes de trace manquantes (recalcul des dérivées des streams)"
  task backfill: :environment do
    started = Time.current
    puts "Recalcul des dérivées des streams (dont l'empreinte de trace)…"
    report = ActivityDerivationsBackfill.call
    puts "#{report[:scanned]} activité(s) examinée(s) — #{report[:updated]} mise(s) à jour, " \
         "#{report[:unchanged]} déjà à jour"
    puts "terminé en #{(Time.current - started).round(1)} s"
  end

  desc "Affiche le nombre d'activités porteuses de streams mais sans empreinte de trace"
  task pending: :environment do
    [ StravaActivity, ImportedActivity ].each do |klass|
      pending = klass.with_streams.where(track_cells: {}).count
      puts "#{klass.name} : #{pending} sans empreinte (sur #{klass.with_streams.count} avec streams)"
    end
  end
end
