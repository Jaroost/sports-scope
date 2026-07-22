#!/usr/bin/env bash
#
# Construit la base de POI locale à partir d'extraits OSM Geofabrik (remplace les
# appels à overpass-api.de). Sert à la fois au bootstrap et au rafraîchissement
# périodique — le script est idempotent, et incrémental côté téléchargement.
#
#   OSM_POI_REGIONS   URLs des .osm.pbf à charger (séparées par des espaces ou des virgules)
#   OSM_POI_DATABASE  base de destination                       (défaut osm_pois_development)
#   DATA_DIR          extraits + fichiers de travail            (défaut /data)
#   PGHOST / PGUSER / PGPASSWORD  connexion PostgreSQL (utilisateur pouvant créer la base)
#
# Pipeline : téléchargement -> osmium tags-filter (ne garde que les tags utiles)
# -> osmium merge -> osmium export en GeoJSON -> extract.py (classification + CSV)
# -> COPY dans une table neuve -> bascule atomique. L'app ne voit jamais de table
# partielle : elle lit `osm_pois`, qui n'est remplacée qu'à la toute fin, en une
# transaction.
#
set -uo pipefail

DATA_DIR=${DATA_DIR:-/data}
PBF_DIR="$DATA_DIR/pbf"
WORK_DIR="$DATA_DIR/work"
DB=${OSM_POI_DATABASE:-osm_pois_development}

# Régions par défaut : Suisse + voisinage cyclable. Élargir via OSM_POI_REGIONS.
DEFAULT_REGIONS="\
https://download.geofabrik.de/europe/switzerland-latest.osm.pbf \
https://download.geofabrik.de/europe/france/rhone-alpes-latest.osm.pbf \
https://download.geofabrik.de/europe/france/franche-comte-latest.osm.pbf \
https://download.geofabrik.de/europe/france/alsace-latest.osm.pbf \
https://download.geofabrik.de/europe/italy/nord-ovest-latest.osm.pbf \
https://download.geofabrik.de/europe/italy/nord-est-latest.osm.pbf \
https://download.geofabrik.de/europe/austria-latest.osm.pbf \
https://download.geofabrik.de/europe/germany/baden-wuerttemberg-latest.osm.pbf"

REGIONS=${OSM_POI_REGIONS:-$DEFAULT_REGIONS}
REGIONS=${REGIONS//,/ }

# Tags conservés par osmium. Transposition directe des clauses Overpass qui
# vivaient dans GeocodesController#places — toute catégorie ajoutée ici doit
# l'être aussi dans extract.py:classify(). `nw` = nodes + ways (les ways donnent
# leur centre de bbox), comme les clauses `node[...]` / `way[...]` d'origine.
FILTERS=(
  "n/place=city,town,village,hamlet"
  "nw/amenity=grave_yard,drinking_water,toilets,cafe,restaurant"
  "nw/landuse=cemetery"
  "nw/shop=bakery"
  "n/natural=spring,peak,saddle"
  "n/mountain_pass=yes"
  "n/tourism=viewpoint,picnic_site"
  "n/leisure=picnic_table"
)

log() { printf '[osm-pois] %s\n' "$*"; }

n_downloaded=0
n_cached=0
n_failed=0

# Télécharge $1 vers $2 uniquement s'il a changé en amont (If-Modified-Since sur
# la date du fichier local). Geofabrik régénère les extraits quotidiennement : sans
# ce test on retéléchargerait plusieurs Go à chaque passe.
fetch_if_changed() {
  local url=$1 dest=$2

  if curl -fsSL --max-time 3600 --retry 3 --retry-delay 10 \
       --remote-time -z "$dest" -o "$dest.part" "$url"; then
    if [ -s "$dest.part" ]; then
      mv -f "$dest.part" "$dest"
      n_downloaded=$(( n_downloaded + 1 ))
      log "  maj $(basename "$dest") ($(( $(stat -c %s "$dest") / 1024 / 1024 )) Mo)"
    else
      # 304 : curl a laissé un fichier vide, l'extrait local est à jour.
      rm -f "$dest.part"
      n_cached=$(( n_cached + 1 ))
    fi
    return 0
  fi

  rm -f "$dest.part"
  return 1
}

download_regions() {
  local url name
  mkdir -p "$PBF_DIR"
  log "extraits OSM -> $PBF_DIR"

  for url in $REGIONS; do
    name=$(basename "$url")
    if ! fetch_if_changed "$url" "$PBF_DIR/$name"; then
      n_failed=$(( n_failed + 1 ))
      log "  ECHEC $name"
    fi
  done
}

# Filtre chaque extrait séparément (un extrait inchangé n'est pas refiltré), puis
# fusionne. La fusion dédoublonne les objets présents dans plusieurs extraits
# (régions frontalières qui se recouvrent) : même ID OSM = un seul objet.
filter_and_merge() {
  local url src name filtered inputs=()
  mkdir -p "$WORK_DIR"

  # On itère sur OSM_POI_REGIONS et non sur le contenu de $PBF_DIR : un extrait
  # retiré de la liste reste sur le volume mais sort du catalogue.
  for url in $REGIONS; do
    name=$(basename "$url" .osm.pbf)
    src="$PBF_DIR/$name.osm.pbf"
    [ -f "$src" ] || continue
    filtered="$WORK_DIR/$name.filtered.pbf"

    if [ ! -f "$filtered" ] || [ "$src" -nt "$filtered" ]; then
      log "  filtrage $name"
      if ! osmium tags-filter --overwrite -o "$filtered" "$src" "${FILTERS[@]}"; then
        log "  ECHEC filtrage $name"
        n_failed=$(( n_failed + 1 ))
        rm -f "$filtered"
        continue
      fi
    fi
    inputs+=("$filtered")
  done

  if [ ${#inputs[@]} -eq 0 ]; then
    log "ECHEC aucun extrait exploitable"
    return 1
  fi

  log "fusion de ${#inputs[@]} extrait(s)"
  osmium merge --overwrite -o "$WORK_DIR/merged.pbf" "${inputs[@]}"
}

# Crée la base si elle n'existe pas. L'init-script du container postgres ne peut
# pas s'en charger : il ne tourne qu'au tout premier boot, et le volume existe
# déjà en prod.
ensure_database() {
  if [ "$(psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'" postgres)" = "1" ]; then
    return 0
  fi
  log "création de la base $DB"
  createdb "$DB"
}

# Charge le CSV dans une table neuve puis bascule. Les index sont créés avant la
# bascule (donc hors du chemin critique) et renommés avec la table, sinon leurs
# noms `osm_pois_new_*` resteraient pris et la synchro suivante échouerait.
load() {
  local csv="$WORK_DIR/pois.csv"

  log "export GeoJSON + classification"
  if ! osmium export --overwrite -f geojsonseq \
         --geometry-types=point,linestring,polygon \
         -o "$WORK_DIR/pois.geojsonseq" "$WORK_DIR/merged.pbf"; then
    log "ECHEC export osmium"
    return 1
  fi

  if ! python3 /extract.py < "$WORK_DIR/pois.geojsonseq" > "$csv"; then
    log "ECHEC extraction (aucun POI produit) — table existante conservée"
    return 1
  fi

  log "chargement dans $DB"
  psql -v ON_ERROR_STOP=1 -d "$DB" <<-SQL || return 1
	DROP TABLE IF EXISTS osm_pois_new;
	CREATE TABLE osm_pois_new (
	  category text NOT NULL,
	  name     text,
	  lat      double precision NOT NULL,
	  lng      double precision NOT NULL
	);
	\\copy osm_pois_new (category, name, lat, lng) FROM '$csv' WITH (FORMAT csv, NULL '')
	CREATE INDEX osm_pois_new_lat_lng_idx ON osm_pois_new (lat, lng);
	CREATE INDEX osm_pois_new_category_idx ON osm_pois_new (category);
	ANALYZE osm_pois_new;

	BEGIN;
	DROP TABLE IF EXISTS osm_pois;
	ALTER TABLE osm_pois_new RENAME TO osm_pois;
	ALTER INDEX osm_pois_new_lat_lng_idx RENAME TO osm_pois_lat_lng_idx;
	ALTER INDEX osm_pois_new_category_idx RENAME TO osm_pois_category_idx;
	COMMIT;
	SQL

  rm -f "$csv" "$WORK_DIR/pois.geojsonseq"
}

log "démarrage (base $DB)"
mkdir -p "$DATA_DIR"

download_regions

if ensure_database && filter_and_merge && load; then
  # Marqueur « il y a des POI à servir », lu par le healthcheck. Il vit dans le
  # volume : seule la toute première synchro fait attendre.
  touch "$DATA_DIR/.sync-complete"
  log "terminé — $n_downloaded extrait(s) mis à jour, $n_cached à jour, $n_failed échec(s)"
else
  log "ECHEC de la synchro — les POI déjà en base restent servis"
  n_failed=$(( n_failed + 1 ))
fi

[ "$n_failed" -eq 0 ]
