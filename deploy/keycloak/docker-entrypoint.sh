#!/bin/bash
set -e

IMPORT_DIR=/opt/keycloak/data/import
TEMPLATE_DIR=/opt/keycloak/templates

mkdir -p "$IMPORT_DIR"

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

exec /opt/keycloak/bin/kc.sh "$@"
