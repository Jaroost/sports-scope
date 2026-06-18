# Sert le fichier Digital Asset Links qui lie l'app Android (TWA) au domaine.
# Sans lui, l'app afficherait une barre d'URL au lieu d'un vrai plein écran.
# https://developers.google.com/digital-asset-links/v1/getting-started
#
# Valeurs fournies par l'environnement (renseignées après `bubblewrap init` /
# Play Console) :
#   ANDROID_PACKAGE_NAME       ex. "ch.logicraft.sports"
#   ANDROID_CERT_FINGERPRINTS  empreintes SHA-256, séparées par des virgules
#                              (clé d'upload locale + clé de signature Play)
class WellKnownController < ApplicationController
  def assetlinks
    package = ENV["ANDROID_PACKAGE_NAME"].to_s.strip
    fingerprints = ENV["ANDROID_CERT_FINGERPRINTS"].to_s.split(",").map(&:strip).reject(&:blank?)

    # Tant que rien n'est configuré, on renvoie 404 plutôt qu'un fichier invalide.
    return head :not_found if package.blank? || fingerprints.empty?

    render json: [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: package,
          sha256_cert_fingerprints: fingerprints
        }
      }
    ]
  end
end
