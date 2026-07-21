class AddLocalitiesToRoutes < ActiveRecord::Migration[8.1]
  def up
    enable_extension "pg_trgm" unless extension_enabled?("pg_trgm")

    add_column :routes, :localities, :jsonb, default: [], null: false

    # Recherche par lieu = ILIKE '%…%' sur les noms. Un index GIN jsonb classique
    # (jsonb_ops) n'accélère que la containment `@>`, pas le sous-terme : on indexe
    # donc le rendu texte du tableau en trigrammes. Le cast jsonb→text est IMMUTABLE
    # (jsonb_out), contrairement à array_to_string qui est STABLE et interdirait
    # l'index d'expression — c'est la raison du choix jsonb plutôt que text[].
    execute <<~SQL
      CREATE INDEX index_routes_on_localities_trgm
        ON routes USING gin ((localities::text) gin_trgm_ops)
    SQL

    # Le filtre de recherche est `name ILIKE … OR localities ILIKE …`. Postgres ne
    # combine deux index (BitmapOr) que si les DEUX côtés du OR sont indexés :
    # sans index trigram sur `name`, il retombe en seq scan et celui sur
    # `localities` ne sert jamais.
    execute <<~SQL
      CREATE INDEX index_routes_on_name_trgm
        ON routes USING gin (name gin_trgm_ops)
    SQL

    # Les itinéraires existants n'ont pas de lieux : on les extrait hors migration
    # (l'extraction dépend du catalogue OSM, une migration ne doit pas en dépendre).
    say "Lieux des itinéraires existants : lancer `bin/rails localities:backfill` " \
        "pour peupler `routes.localities`."
  end

  def down
    remove_index :routes, name: "index_routes_on_name_trgm"
    remove_index :routes, name: "index_routes_on_localities_trgm"
    remove_column :routes, :localities
  end
end
