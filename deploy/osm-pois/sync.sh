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
# -> osmium export en GeoJSON, extrait par extrait -> extract.py (classification +
# CSV) -> COPY dans une table de transit -> dédoublonnage -> bascule atomique.
# L'app ne voit jamais de table partielle : elle lit `osm_pois`, qui n'est remplacée
# qu'à la toute fin, en une transaction.
#
# L'export est fait extrait par extrait (et non sur une fusion `osmium merge` comme
# avant) pour que chaque POI porte le pays de l'extrait dont il vient : c'est la
# seule source de pays disponible ici, et elle alimente les « pays traversés »
# (LocalitiesExtractor). Le dédoublonnage que faisait la fusion — un objet présent
# dans deux extraits frontaliers — est repris en SQL, sur (catégorie, nom, lat, lng) :
# un même objet OSM a exactement les mêmes coordonnées dans les deux extraits.
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
  "nw/amenity=grave_yard,drinking_water,toilets,cafe,restaurant,parking"
  "nw/landuse=cemetery"
  "nw/shop=bakery"
  "n/natural=spring,peak,saddle"
  "n/mountain_pass=yes"
  "n/tourism=viewpoint,picnic_site"
  "n/leisure=picnic_table"
)

# Pays (ISO 3166-1 alpha-2) des extraits Geofabrik, d'après leur chemin : les
# extraits nationaux (`europe/switzerland-latest.osm.pbf`) portent le pays dans le
# nom du fichier, les sous-régions (`europe/france/alsace-latest.osm.pbf`) dans le
# dossier parent. Un extrait absent de cette table donne un pays vide (NULL) : ses
# POI restent servis, ils ne comptent simplement pas pour les pays traversés.
declare -A COUNTRY_CODES=(
  [albania]=AL [andorra]=AD [austria]=AT [belarus]=BY [belgium]=BE
  [bosnia-herzegovina]=BA [bulgaria]=BG [croatia]=HR [cyprus]=CY
  [czech-republic]=CZ [denmark]=DK [estonia]=EE [finland]=FI [france]=FR
  [germany]=DE [great-britain]=GB [greece]=GR [hungary]=HU [iceland]=IS
  [ireland]=IE [italy]=IT [kosovo]=XK [latvia]=LV [liechtenstein]=LI
  [lithuania]=LT [luxembourg]=LU [macedonia]=MK [malta]=MT [moldova]=MD
  [monaco]=MC [montenegro]=ME [netherlands]=NL [norway]=NO [poland]=PL
  [portugal]=PT [romania]=RO [serbia]=RS [slovakia]=SK [slovenia]=SI
  [spain]=ES [sweden]=SE [switzerland]=CH [turkey]=TR [ukraine]=UA
)

# Code pays d'une URL d'extrait, ou chaîne vide s'il n'est pas dans la table.
country_for_url() {
  local path=${1#*://}     # download.geofabrik.de/europe/france/alsace-latest.osm.pbf
  path=${path#*/}          # europe/france/alsace-latest.osm.pbf
  local name
  if [[ "$path" == */*/* ]]; then
    # Sous-région : le pays est le dossier parent (europe/france/alsace-…).
    name=${path%/*}
    name=${name##*/}
  else
    # Extrait national : europe/switzerland-latest.osm.pbf.
    name=$(basename "$path" -latest.osm.pbf)
  fi
  printf '%s' "${COUNTRY_CODES[$name]:-}"
}

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

# Filtre chaque extrait séparément (un extrait inchangé n'est pas refiltré) et
# renseigne FILTERED avec des entrées `chemin|pays` : l'export qui suit se fait
# extrait par extrait, pour garder l'origine — donc le pays — de chaque POI.
FILTERED=()

filter_regions() {
  local url src name filtered country sig sig_file
  mkdir -p "$WORK_DIR"
  FILTERED=()

  # Empreinte de FILTERS : sans elle, ajouter une catégorie ne referait pas le
  # filtrage (le .pbf source n'a pas changé) et la nouvelle catégorie resterait
  # absente du catalogue jusqu'au prochain rafraîchissement Geofabrik.
  sig=$(printf '%s\n' "${FILTERS[@]}" | md5sum | cut -d' ' -f1)

  # On itère sur OSM_POI_REGIONS et non sur le contenu de $PBF_DIR : un extrait
  # retiré de la liste reste sur le volume mais sort du catalogue.
  for url in $REGIONS; do
    name=$(basename "$url" .osm.pbf)
    src="$PBF_DIR/$name.osm.pbf"
    [ -f "$src" ] || continue
    filtered="$WORK_DIR/$name.filtered.pbf"
    sig_file="$WORK_DIR/$name.filters"

    if [ ! -f "$filtered" ] || [ "$src" -nt "$filtered" ] || \
       [ "$(cat "$sig_file" 2>/dev/null)" != "$sig" ]; then
      log "  filtrage $name"
      rm -f "$sig_file"
      if ! osmium tags-filter --overwrite -o "$filtered" "$src" "${FILTERS[@]}"; then
        log "  ECHEC filtrage $name"
        n_failed=$(( n_failed + 1 ))
        rm -f "$filtered"
        continue
      fi
      printf '%s\n' "$sig" > "$sig_file"
    fi
    country=$(country_for_url "$url")
    [ -n "$country" ] || log "  $name : pays inconnu (POI sans pays)"
    FILTERED+=("$filtered|$country")
  done

  if [ ${#FILTERED[@]} -eq 0 ]; then
    log "ECHEC aucun extrait exploitable"
    return 1
  fi
}

# Exporte chaque extrait filtré et le classe (extract.py), en concaténant les CSV.
# Un extrait qui échoue est signalé mais n'invalide pas les autres : c'est le CSV
# global vide qui fait échouer la synchro, table existante conservée.
export_and_extract() {
  local csv=$1 entry filtered country seq name ok=0

  : > "$csv"
  for entry in "${FILTERED[@]}"; do
    filtered=${entry%|*}
    country=${entry##*|}
    name=$(basename "$filtered" .filtered.pbf)
    seq="$WORK_DIR/$name.geojsonseq"

    log "  export + classification $name${country:+ ($country)}"
    if ! osmium export --overwrite -f geojsonseq \
           --geometry-types=point,linestring,polygon \
           -o "$seq" "$filtered"; then
      log "  ECHEC export $name"
      n_failed=$(( n_failed + 1 ))
      rm -f "$seq"
      continue
    fi

    if python3 /extract.py --country "$country" < "$seq" >> "$csv"; then
      ok=$(( ok + 1 ))
    else
      log "  ECHEC classification $name"
      n_failed=$(( n_failed + 1 ))
    fi
    rm -f "$seq"
  done

  if [ "$ok" -eq 0 ] || [ ! -s "$csv" ]; then
    log "ECHEC extraction (aucun POI produit) — table existante conservée"
    return 1
  fi
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

  export_and_extract "$csv" || return 1

  # `osm_pois_stage` : table de transit, chargée dans l'ordre des extraits. Le
  # dédoublonnage (objet présent dans deux extraits frontaliers) se fait ensuite
  # sur (catégorie, nom, lat, lng), en gardant la première occurrence — donc le
  # pays du premier extrait de OSM_POI_REGIONS qui le contient.
  log "chargement dans $DB"
  psql -v ON_ERROR_STOP=1 -d "$DB" <<-SQL || return 1
	DROP TABLE IF EXISTS osm_pois_stage;
	DROP TABLE IF EXISTS osm_pois_new;
	CREATE TABLE osm_pois_stage (
	  category text NOT NULL,
	  name     text,
	  lat      double precision NOT NULL,
	  lng      double precision NOT NULL,
	  country  text,
	  ord      bigserial
	);
	\\copy osm_pois_stage (category, name, lat, lng, country) FROM '$csv' WITH (FORMAT csv, NULL '')

	CREATE TABLE osm_pois_new AS
	SELECT category, name, lat, lng, country
	FROM (
	  SELECT DISTINCT ON (category, name, lat, lng) *
	  FROM osm_pois_stage
	  ORDER BY category, name, lat, lng, ord
	) deduped;
	ALTER TABLE osm_pois_new ALTER COLUMN category SET NOT NULL;
	ALTER TABLE osm_pois_new ALTER COLUMN lat SET NOT NULL;
	ALTER TABLE osm_pois_new ALTER COLUMN lng SET NOT NULL;
	DROP TABLE osm_pois_stage;

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

  rm -f "$csv"
}

log "démarrage (base $DB)"
mkdir -p "$DATA_DIR"

download_regions

if ensure_database && filter_regions && load; then
  # Marqueur « il y a des POI à servir », lu par le healthcheck. Il vit dans le
  # volume : seule la toute première synchro fait attendre.
  touch "$DATA_DIR/.sync-complete"
  log "terminé — $n_downloaded extrait(s) mis à jour, $n_cached à jour, $n_failed échec(s)"
else
  log "ECHEC de la synchro — les POI déjà en base restent servis"
  n_failed=$(( n_failed + 1 ))
fi

[ "$n_failed" -eq 0 ]
