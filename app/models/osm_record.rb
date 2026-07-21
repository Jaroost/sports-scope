# Base des modèles lisant le catalogue OpenStreetMap importé (base `osm`), séparée
# de la base applicative : son schéma est créé par le service `poi-sync`
# (deploy/osm-pois/sync.sh) et rechargé en entier à chaque synchro, donc jamais
# décrit par une migration ni présent dans db/schema.rb.
#
# Lecture seule côté app : la seule écriture est celle du script d'import.
class OsmRecord < ActiveRecord::Base
  self.abstract_class = true

  connects_to database: { writing: :osm, reading: :osm }
end
