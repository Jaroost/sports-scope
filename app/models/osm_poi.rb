# Point d'intérêt issu du catalogue OpenStreetMap importé localement (table
# `osm_pois` de la base `osm`, reconstruite à chaque synchro par
# deploy/osm-pois/sync.sh). Remplace les appels à Overpass.
#
# À ne pas confondre avec `Poi`, qui est un POI personnel de l'utilisateur.
#
# `category` porte directement la valeur attendue par le front (`serverTypes` dans
# app/javascript/poiCategories.ts) : la classification est faite à l'import
# (deploy/osm-pois/extract.py:classify), pas à la lecture.
class OsmPoi < OsmRecord
  self.table_name = "osm_pois"
  # La table n'a pas de clé primaire : elle est rechargée en entier à chaque
  # synchro, les identifiants n'auraient aucune stabilité. Lecture par bbox
  # uniquement.
  self.primary_key = nil

  # Garde-fou contre une réponse démesurée (bbox pathologique). Une bbox de tracé
  # normale, même sur une sortie de 300 km, reste très en dessous.
  MAX_RESULTS = 10_000

  # POI dont le point est dans la bbox (mêmes bornes que les bbox Overpass qu'on
  # remplace : sud, ouest, nord, est).
  scope :in_bbox, ->(south, west, north, east) {
    where(lat: south..north, lng: west..east).limit(MAX_RESULTS)
  }
end
