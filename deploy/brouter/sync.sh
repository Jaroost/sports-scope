#!/usr/bin/env bash
#
# Synchronise les données de routage BRouter depuis brouter.de vers les volumes
# partagés avec le service `brouter`. Sert à la fois au bootstrap (premier
# démarrage : ~3,4 Go pour l'Europe) et au rafraîchissement périodique — le
# script est idempotent et incrémental.
#
#   BROUTER_BBOX   lon_min,lat_min,lon_max,lat_max (défaut Europe)
#   SEGMENTS_DIR   destination des tuiles .rd5            (défaut /segments4)
#   PROFILES_DIR   destination des profils + lookups.dat  (défaut /profiles2)
#   OVERLAY_DIR    profils maison copiés par-dessus       (défaut /profiles-overlay)
#
# Les fichiers sont écrits sous .part puis renommés : le rename est atomique et
# une requête en cours garde son descripteur sur l'ancien inode. Aucun
# redémarrage de BRouter n'est nécessaire après une synchro.
#
set -uo pipefail

BASE_URL=${BROUTER_BASE_URL:-https://brouter.de/brouter}
SEGMENTS_DIR=${SEGMENTS_DIR:-/segments4}
PROFILES_DIR=${PROFILES_DIR:-/profiles2}
OVERLAY_DIR=${OVERLAY_DIR:-/profiles-overlay}
BBOX=${BROUTER_BBOX:--30,30,45,70}

log() { printf '[brouter-sync] %s\n' "$*"; }

n_ok=0        # déjà à jour
n_updated=0   # (re)téléchargés
n_failed=0
bytes=0

# Arrondi à l'inférieur sur la grille de 5° (les tuiles sont nommées d'après leur
# coin sud-ouest). En bash la division tronque vers zéro, d'où le -4 côté négatif.
floor5() {
  local v=$1
  if [ "$v" -ge 0 ]; then echo $(( v / 5 * 5 )); else echo $(( (v - 4) / 5 * 5 )); fi
}

tile_name() {
  local lon=$1 lat=$2 ew ns
  if [ "$lon" -ge 0 ]; then ew="E$lon"; else ew="W$(( -lon ))"; fi
  if [ "$lat" -ge 0 ]; then ns="N$lat"; else ns="S$(( -lat ))"; fi
  echo "${ew}_${ns}"
}

# Télécharge $1 (URL) vers $2 si la taille locale diffère de la taille distante.
# Retourne 0 si à jour ou téléchargé, 1 en cas d'erreur, 2 si absent en amont (404).
fetch_if_changed() {
  local url=$1 dest=$2 headers remote_size local_size

  headers=$(curl -fsIL --max-time 120 "$url" 2>/dev/null)
  if [ $? -ne 0 ]; then
    case "$(curl -sIL -o /dev/null -w '%{http_code}' --max-time 120 "$url")" in
      404) return 2 ;;
      *) return 1 ;;
    esac
  fi

  remote_size=$(printf '%s' "$headers" | tr -d '\r' \
    | awk 'tolower($1) == "content-length:" { v = $2 } END { print v }')

  if [ -f "$dest" ] && [ -n "$remote_size" ]; then
    local_size=$(stat -c %s "$dest")
    if [ "$local_size" = "$remote_size" ]; then
      n_ok=$(( n_ok + 1 ))
      return 0
    fi
  fi

  if curl -fsSL --max-time 3600 --retry 3 --retry-delay 10 --remote-time \
       -o "$dest.part" "$url"; then
    mv -f "$dest.part" "$dest"
    n_updated=$(( n_updated + 1 ))
    bytes=$(( bytes + $(stat -c %s "$dest") ))
    log "  maj $(basename "$dest") ($(( $(stat -c %s "$dest") / 1024 / 1024 )) Mo)"
    return 0
  fi

  rm -f "$dest.part"
  return 1
}

sync_segments() {
  local lon_min lat_min lon_max lat_max lon lat name rc
  IFS=, read -r lon_min lat_min lon_max lat_max <<< "$BBOX"

  lon_min=$(floor5 "$lon_min"); lat_min=$(floor5 "$lat_min")

  log "tuiles .rd5 pour bbox $BBOX -> $SEGMENTS_DIR"
  mkdir -p "$SEGMENTS_DIR"

  for (( lon = lon_min; lon <= lon_max; lon += 5 )); do
    for (( lat = lat_min; lat <= lat_max; lat += 5 )); do
      name=$(tile_name "$lon" "$lat")
      fetch_if_changed "$BASE_URL/segments4/$name.rd5" "$SEGMENTS_DIR/$name.rd5"
      rc=$?
      # rc=2 : tuile inexistante en amont (océan) — normal, on l'ignore.
      if [ $rc -eq 1 ]; then
        n_failed=$(( n_failed + 1 ))
        log "  ECHEC $name.rd5"
      fi
    done
  done
}

sync_profiles() {
  local listing files f
  log "profils + lookups.dat -> $PROFILES_DIR"
  mkdir -p "$PROFILES_DIR"

  listing=$(curl -fsSL --max-time 120 "$BASE_URL/profiles2/")
  if [ $? -ne 0 ]; then
    log "  ECHEC listing des profils — profils existants conservés"
    n_failed=$(( n_failed + 1 ))
    return
  fi

  files=$(printf '%s' "$listing" | grep -oE 'href="[^"]+\.brf"' | cut -d'"' -f2)

  # lookups.dat est la table de tags de référence du format .rd5 : elle doit
  # impérativement venir de la même source que les tuiles.
  for f in $files lookups.dat; do
    if ! fetch_if_changed "$BASE_URL/profiles2/$f" "$PROFILES_DIR/$f"; then
      n_failed=$(( n_failed + 1 ))
      log "  ECHEC $f"
    fi
  done
}

# Profils maison versionnés dans le repo (deploy/brouter/profiles/), appliqués
# par-dessus le miroir : ils gagnent sur la version amont à chaque synchro.
apply_overlay() {
  local n=0 f
  [ -d "$OVERLAY_DIR" ] || return 0
  for f in "$OVERLAY_DIR"/*.brf; do
    [ -e "$f" ] || continue
    cp -f "$f" "$PROFILES_DIR/$(basename "$f")"
    n=$(( n + 1 ))
  done
  [ "$n" -gt 0 ] && log "overlay : $n profil(s) maison appliqué(s)"
  return 0
}

log "démarrage (source $BASE_URL)"
sync_segments
sync_profiles
apply_overlay
log "terminé — $n_ok fichier(s) à jour, $n_updated mis à jour ($(( bytes / 1024 / 1024 )) Mo), $n_failed échec(s)"

# Marqueur « données exploitables » : lu par le healthcheck du service brouter-sync,
# dont dépend le démarrage du moteur. Posé dès qu'il y a de quoi router (au moins une
# tuile + la table de tags), pas seulement quand la passe est parfaite — une tuile en
# échec ne doit pas empêcher le moteur de servir le reste. Il vit dans le volume, donc
# les redémarrages suivants ne réattendent pas le téléchargement.
if [ -f "$PROFILES_DIR/lookups.dat" ] && ls "$SEGMENTS_DIR"/*.rd5 >/dev/null 2>&1; then
  touch "$SEGMENTS_DIR/.sync-complete"
else
  log "ATTENTION données incomplètes (pas de tuile ou pas de lookups.dat)"
fi

[ "$n_failed" -eq 0 ]
