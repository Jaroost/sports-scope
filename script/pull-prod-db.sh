#!/usr/bin/env bash
#
# Rapatrie les données de production (base app + base Keycloak) dans la stack
# de dev locale.
#
#   PROD_SSH=moi@jaroost-server script/pull-prod-db.sh
#
# ATTENTION : écrase intégralement les bases locales `sports_scope_development`
# et `keycloak`. Les bases locales sont sauvegardées dans tmp/db-backups/ avant
# tout écrasement.
#
# Copie brute : les tokens OAuth Strava des utilisateurs de prod atterrissent
# tels quels sur ce poste, et l'app dev pourra appeler Strava en leur nom.
#
# Les identifiants Postgres sont lus dans les containers (pas de .env) : la
# connexion passe par le socket unix local du container, en auth trust.
#
set -euo pipefail

PROD_SSH=${PROD_SSH:-ajaquet@jaroost-server}
PROD_DB_CONTAINER=${PROD_DB_CONTAINER:-sports-scope-db-1}
LOCAL_DB_CONTAINER=${LOCAL_DB_CONTAINER:-sports-scope-db-1}
PROD_APP_DB=${PROD_APP_DB:-sports_scope_production}
LOCAL_APP_DB=${LOCAL_APP_DB:-sports_scope_development}

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

dump_dir=$(mktemp -d)
backup_dir="tmp/db-backups/$(date +%Y%m%d-%H%M%S)"
trap 'rm -rf "$dump_dir"' EXIT

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mErreur:\033[0m %s\n' "$1" >&2; exit 1; }

# psql superuser sur le container local, via socket unix.
lpsql() {
  docker exec -i -u postgres "$LOCAL_DB_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$LOCAL_PG_USER" "$@"
}

# Vide une base : coupe les connexions, drop, recrée avec le bon propriétaire.
reset_db() {
  local db=$1 owner=$2
  lpsql -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = '$db' AND pid <> pg_backend_pid();" >/dev/null
  lpsql -d postgres -c "DROP DATABASE IF EXISTS \"$db\";" >/dev/null
  lpsql -d postgres -c "CREATE DATABASE \"$db\" OWNER \"$owner\";" >/dev/null
}

# ---------------------------------------------------------------- préliminaires

[ -n "$PROD_SSH" ] || die "définis PROD_SSH, ex. PROD_SSH=moi@jaroost-server $0"

log "Vérifications"

docker inspect "$LOCAL_DB_CONTAINER" >/dev/null 2>&1 \
  || die "container local $LOCAL_DB_CONTAINER absent — lance 'docker compose up -d' d'abord"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$PROD_SSH" true 2>/dev/null \
  || die "SSH vers $PROD_SSH impossible (clé publique ?)"

ssh "$PROD_SSH" "docker inspect $PROD_DB_CONTAINER >/dev/null 2>&1" \
  || die "container $PROD_DB_CONTAINER introuvable sur $PROD_SSH — surcharge PROD_DB_CONTAINER"

LOCAL_PG_USER=$(docker exec "$LOCAL_DB_CONTAINER" printenv POSTGRES_USER)
PROD_PG_USER=$(ssh "$PROD_SSH" "docker exec $PROD_DB_CONTAINER printenv POSTGRES_USER")
[ -n "$LOCAL_PG_USER" ] && [ -n "$PROD_PG_USER" ] || die "POSTGRES_USER introuvable dans un des containers"

# ------------------------------------------------------------------ dump distant

log "Dump de la prod ($PROD_SSH)"

ssh "$PROD_SSH" "docker exec -u postgres $PROD_DB_CONTAINER \
  pg_dump -U '$PROD_PG_USER' -d '$PROD_APP_DB' --no-owner --no-privileges | gzip -c" > "$dump_dir/app.sql.gz"

ssh "$PROD_SSH" "docker exec -u postgres $PROD_DB_CONTAINER \
  pg_dump -U keycloak -d keycloak --no-owner --no-privileges | gzip -c" > "$dump_dir/keycloak.sql.gz"

for f in app keycloak; do
  gzip -t "$dump_dir/$f.sql.gz" 2>/dev/null || die "dump $f corrompu ou vide"
  printf '    %-9s %s\n' "$f" "$(du -h "$dump_dir/$f.sql.gz" | cut -f1)"
done

# ------------------------------------------------- sauvegarde des bases locales

log "Sauvegarde des bases locales → $backup_dir"

mkdir -p "$backup_dir"
for db in "$LOCAL_APP_DB" keycloak; do
  if docker exec -u postgres "$LOCAL_DB_CONTAINER" \
       pg_dump -U "$LOCAL_PG_USER" -d "$db" --no-owner --no-privileges 2>/dev/null \
       | gzip -c > "$backup_dir/$db.sql.gz" && [ -s "$backup_dir/$db.sql.gz" ]; then
    printf '    %-28s %s\n' "$db" "$(du -h "$backup_dir/$db.sql.gz" | cut -f1)"
  else
    rm -f "$backup_dir/$db.sql.gz"
    printf '    %-28s (absente, rien à sauver)\n' "$db"
  fi
done

# ------------------------------------------------------------------- restauration

log "Arrêt de rails et keycloak (ils tiennent des connexions ouvertes)"
docker compose stop rails keycloak >/dev/null 2>&1 || true

log "Restauration de la base app → $LOCAL_APP_DB"
reset_db "$LOCAL_APP_DB" "$LOCAL_PG_USER"
gunzip -c "$dump_dir/app.sql.gz" | lpsql -q -d "$LOCAL_APP_DB" >/dev/null

log "Restauration de la base keycloak"
reset_db keycloak keycloak
gunzip -c "$dump_dir/keycloak.sql.gz" \
  | docker exec -i -u postgres "$LOCAL_DB_CONTAINER" \
      psql -v ON_ERROR_STOP=1 -q -U keycloak -d keycloak >/dev/null

log "Redémarrage de keycloak et rails"
docker compose start keycloak rails >/dev/null

log "Migrations (le schéma de prod peut être en retard sur cette branche)"
docker compose exec -T rails bin/rails db:migrate

log "Terminé."
cat <<EOF

  Données de prod en place. Sauvegarde des anciennes bases : $backup_dir

  Le realm Keycloak de prod a remplacé le local : ses URLs de redirection
  pointent vers le domaine de prod. Pour te connecter en local, ouvre la console
  Keycloak et ajoute https://app.localtest.me/* aux "Valid redirect URIs" et
  "Web origins" du client rails-app.

EOF
