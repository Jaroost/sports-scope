#!/usr/bin/env bash
#
# Publie l'APK de l'app compagnon sur le site : dépose le binaire et son manifeste
# dans le volume `companion_apk` du container Rails de production.
#
#   script/push-apk.sh [chemin/vers/app-release.apk]
#
# Sans argument, prend la dernière release construite dans le dépôt Flutter voisin.
#
# Aucun redéploiement : le site lit le dossier à chaque requête (cf. CompanionRelease),
# la nouvelle version est donc visible dès la fin du script.
#
# Les métadonnées (versionName, versionCode) sont lues DANS l'APK, pas dans le pubspec
# du dépôt voisin : c'est le fichier qu'on publie qui fait foi, et un pubspec modifié
# après le build annoncerait une version que personne n'a téléchargée. Le versionCode
# est ce qui déclenche la mise à jour côté app — se tromper, c'est soit ne jamais
# proposer la nouvelle version, soit la proposer en boucle après installation.
#
set -euo pipefail

PROD_SSH=${PROD_SSH:-ajaquet@jaroost-server}
PROD_RAILS_CONTAINER=${PROD_RAILS_CONTAINER:-sports-scope-rails-1}
REMOTE_DIR=${REMOTE_DIR:-/app/storage/companion}
DEFAULT_APK=${DEFAULT_APK:-$HOME/dev/sports-scope-companion/build/app/outputs/flutter-apk/app-release.apk}

APK=${1:-$DEFAULT_APK}

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mErreur:\033[0m %s\n' "$1" >&2; exit 1; }

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

# ---------------------------------------------------------------- préliminaires

[ -f "$APK" ] || die "APK introuvable : $APK
  Construis-le d'abord :  cd ~/dev/sports-scope-companion && flutter build apk --release --target-platform android-arm64"

aapt2=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/*/aapt2 2>/dev/null | tail -1) \
  || die "aapt2 introuvable — définis ANDROID_HOME (SDK Android)"
[ -n "$aapt2" ] || die "aapt2 introuvable sous ${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools/"

apksigner=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/*/apksigner 2>/dev/null | tail -1 || true)

ssh -o BatchMode=yes -o ConnectTimeout=10 "$PROD_SSH" true 2>/dev/null \
  || die "connexion ssh impossible vers $PROD_SSH"
ssh "$PROD_SSH" "docker inspect $PROD_RAILS_CONTAINER >/dev/null 2>&1" \
  || die "container $PROD_RAILS_CONTAINER absent sur $PROD_SSH"

# ------------------------------------------------------------------ métadonnées

log "Lecture de $APK"

badging=$("$aapt2" dump badging "$APK")
package=$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$badging")
version_code=$(sed -n "s/^package:.*versionCode='\([^']*\)'.*/\1/p" <<<"$badging")
version_name=$(sed -n "s/^package:.*versionName='\([^']*\)'.*/\1/p" <<<"$badging")

[ -n "$version_code" ] || die "versionCode illisible dans l'APK"
[ -n "$version_name" ] || die "versionName illisible dans l'APK"

# Garde-fou : publier l'APK d'un autre paquet donnerait une app qu'aucun téléphone ne
# peut installer par-dessus la précédente (Android tient un autre applicationId pour
# une autre application).
expected_package=${EXPECTED_PACKAGE:-ch.logicraft.sports.companion}
[ "$package" = "$expected_package" ] \
  || die "paquet inattendu : $package (attendu $expected_package)"

# Un APK signé debug s'installe et se distribue sans rien signaler ; le piège ne se
# referme qu'à la mise à jour suivante, qu'Android refusera. On vérifie donc ici.
if [ -n "$apksigner" ]; then
  if ! "$apksigner" verify "$APK" >/dev/null 2>&1; then
    die "APK non signé (ou signature invalide) — cf. HOWTO.md du dépôt companion"
  fi
  signer_sha=$("$apksigner" verify --print-certs "$APK" | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)
else
  printf 'Attention: apksigner introuvable, signature non vérifiée\n' >&2
  signer_sha=""
fi

size=$(stat -c %s "$APK")
sha256=$(sha256sum "$APK" | cut -d' ' -f1)
filename="sports-scope-companion-${version_name}-${version_code}.apk"

cat >"$staging/manifest.json" <<EOF
{
  "version_name": "$version_name",
  "version_code": $version_code,
  "file": "$filename",
  "size": $size,
  "sha256": "$sha256",
  "released_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

cat <<EOF

  paquet       $package
  version      $version_name (build $version_code)
  taille       $(numfmt --to=iec "$size")
  sha256       $sha256
  signature    ${signer_sha:-non vérifiée}
  destination  $PROD_SSH:$PROD_RAILS_CONTAINER:$REMOTE_DIR/$filename
EOF

read -r -p $'\nPublier ? [y/N] ' answer
[ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "annulé"

# ------------------------------------------------------------------ publication

log "Envoi vers $PROD_SSH"

remote_tmp=$(ssh "$PROD_SSH" "mktemp -d")
# shellcheck disable=SC2029  # $remote_tmp doit bien être développé côté local
trap 'rm -rf "$staging"; ssh "$PROD_SSH" "rm -rf $remote_tmp" 2>/dev/null || true' EXIT

scp -q "$APK" "$PROD_SSH:$remote_tmp/$filename"
scp -q "$staging/manifest.json" "$PROD_SSH:$remote_tmp/manifest.json"

log "Dépôt dans le volume du container"

# Ordre imposé : le binaire d'abord, le manifeste ensuite. Le manifeste est ce qui
# rend une version visible (CompanionRelease#available? vérifie que le fichier existe),
# donc l'écrire en dernier évite qu'une requête tombe sur une version annoncée mais
# pas encore arrivée.
ssh "$PROD_SSH" "
  set -e
  docker exec $PROD_RAILS_CONTAINER mkdir -p $REMOTE_DIR
  docker cp $remote_tmp/$filename $PROD_RAILS_CONTAINER:$REMOTE_DIR/$filename
  docker cp $remote_tmp/manifest.json $PROD_RAILS_CONTAINER:$REMOTE_DIR/manifest.json
"

log "Ménage des versions précédentes"

# Après le manifeste seulement : plus rien ne les référence à ce stade.
ssh "$PROD_SSH" "docker exec $PROD_RAILS_CONTAINER sh -c '
  cd $REMOTE_DIR && for f in *.apk; do
    [ \"\$f\" = \"$filename\" ] || rm -f \"\$f\"
  done
'"

log "Publié : $version_name (build $version_code)"
echo "  https://sports.logicraft.ch/companion"
