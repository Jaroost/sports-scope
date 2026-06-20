#!/bin/bash
set -e

IMPORT_DIR=/opt/keycloak/data/import
TEMPLATE_DIR=/opt/keycloak/templates

REALM="${KEYCLOAK_REALM:-sports-scope}"
ROLES_FILE="$TEMPLATE_DIR/realm-roles.txt"
KCADM=/opt/keycloak/bin/kcadm.sh
KCADM_CONFIG=/tmp/kcadm.config

mkdir -p "$IMPORT_DIR"

# Crée (si absents) les rôles de realm listés dans realm-roles.txt, généré depuis
# config/roles.json (source de vérité). Idempotent et non destructif : contrairement
# à --import-realm (qui ignore un realm existant) ou à `import --override` (destructif),
# kcadm permet d'ajouter les rôles manquants sur un realm déjà en place.
provision_roles() {
  [ -f "$ROLES_FILE" ] || { echo "[roles] $ROLES_FILE absent, skip"; return 0; }

  # Attendre que le serveur réponde et que l'admin puisse se connecter (pas de curl requis).
  until "$KCADM" config credentials --config "$KCADM_CONFIG" \
        --server http://localhost:8080 --realm master \
        --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" \
        >/dev/null 2>&1; do
    sleep 3
  done

  # Attendre que le realm cible existe (import terminé).
  until "$KCADM" get "realms/${REALM}" --config "$KCADM_CONFIG" >/dev/null 2>&1; do
    sleep 3
  done

  while IFS= read -r role || [ -n "$role" ]; do
    [ -z "$role" ] && continue
    if "$KCADM" get "roles/${role}" -r "$REALM" --config "$KCADM_CONFIG" >/dev/null 2>&1; then
      echo "[roles] '${role}' déjà présent"
    else
      if "$KCADM" create roles -r "$REALM" --config "$KCADM_CONFIG" \
           -s "name=${role}" \
           -s "description=Rôle applicatif Sports Scope (géré via config/roles.json)"; then
        echo "[roles] '${role}' créé"
      else
        echo "[roles] échec création '${role}' (réessai au prochain démarrage)"
      fi
    fi
  done < "$ROLES_FILE"
}

for template in "$TEMPLATE_DIR"/*.json; do
  filename=$(basename "$template")
  output="$IMPORT_DIR/$filename"
  cp "$template" "$output"

  while IFS= read -r varname; do
    value="${!varname}"
    escaped="${value//\\/\\\\}"
    escaped="${escaped//&/\\&}"
    sed -i "s|\\\${env\.${varname}}|${escaped}|g" "$output"
  done < <(grep -oP '(?<=\$\{env\.)[A-Z_][A-Z0-9_]*(?=\})' "$template" | sort -u)
done

# Provisioning des rôles en arrière-plan (attend que le serveur soit prêt), puis
# le serveur reste au premier plan via exec (PID principal → signaux/arrêt gracieux intacts).
provision_roles &

exec /opt/keycloak/bin/kc.sh "$@"
