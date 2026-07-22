# Recalcul en masse des lieux traversés (recherche par lieu). Voir
# app/services/localities_backfill.rb.
#
#   bin/rails localities:backfill    # seulement ce qui manque (idempotent)
#   bin/rails localities:recompute   # tout réécrire
#   bin/rails localities:pending     # combien reste-t-il à traiter
#
# Variables d'environnement :
#   USER=<id>              limiter à un utilisateur
#   LIMIT=<n>              plafonner le nombre d'enregistrements (par type)
#   SCOPE=routes|activities  ne traiter qu'un des deux (défaut : les deux)
namespace :localities do
  desc "Extrait les lieux manquants (itinéraires + activités)"
  task backfill: :environment do
    LocalitiesRake.run(only_missing: true)
  end

  desc "Recalcule TOUS les lieux, y compris ceux déjà extraits"
  task recompute: :environment do
    LocalitiesRake.run(only_missing: false)
  end

  desc "Affiche le nombre d'itinéraires / activités sans lieux"
  task pending: :environment do
    counts = LocalitiesBackfill.pending_counts(user: LocalitiesRake.user)
    puts "à traiter — itinéraires : #{counts[:routes]}, activités : #{counts[:activities]}"
  end
end

# Colle entre les tâches rake et LocalitiesBackfill : lecture des variables
# d'environnement et affichage de la progression.
module LocalitiesRake
  module_function

  def user
    id = ENV["USER_ID"].presence || ENV["USER"].presence
    # USER est posé par le shell dans quasiment tous les environnements : on ne
    # l'interprète que s'il ressemble à un identifiant, sinon `rake` filtrerait
    # silencieusement sur l'utilisateur « root ».
    return nil unless id&.match?(/\A\d+\z/)

    ::User.find(id)
  end

  def run(only_missing:)
    scope = ENV["SCOPE"].presence || "all"
    limit = ENV["LIMIT"].presence&.to_i
    target = user

    puts "#{only_missing ? 'Extraction des lieux manquants' : 'Recalcul complet des lieux'}" \
         "#{target ? " — utilisateur #{target.id}" : ''}#{limit ? " — max #{limit} par type" : ''}"

    started = Time.current
    results = {}
    args = { user: target, only_missing: only_missing, limit: limit }

    results[:routes] = LocalitiesBackfill.routes(**args, &method(:report)) if scope != "activities"
    results[:activities] = LocalitiesBackfill.activities(**args, &method(:report)) if scope != "routes"

    puts ""
    results.each do |label, r|
      puts "#{label} : #{r[:processed]} traité(s), #{r[:located]} avec des lieux, #{r[:failed]} en échec"
    end
    puts "terminé en #{(Time.current - started).round(1)} s"
  end

  # Une ligne réécrite en place, tous les 25 enregistrements et à la fin.
  def report(label, processed, total)
    return unless (processed % 25).zero? || processed == total

    print "\r  #{label} : #{processed}/#{total}"
    print "\n" if processed == total
    $stdout.flush
  end
end
