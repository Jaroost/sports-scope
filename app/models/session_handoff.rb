require "securerandom"
require "digest"

# Jeton à usage unique qui transporte une session du navigateur vers l'application
# mobile.
#
# Le problème qu'il résout : le WebView de l'appli a son propre pot de cookies. Un
# utilisateur connecté sur sports.logicraft.ch dans Chrome, qui touche « Naviguer dans
# l'application » sur une page de partage, arriverait sinon en anonyme — sans ses
# itinéraires, sans son fond de carte, sans ses POI — et devrait se reconnecter dans
# l'appli. Le lien porte donc un jeton que l'appli échange aussitôt contre une vraie
# session Rails (cf. SessionsController#handoff).
#
# Contrat de sécurité :
#   - le jeton est aléatoire (128 bits) et n'existe en clair que le temps du lien ;
#   - seule son empreinte SHA-256 est stockée — une copie de la base ne donne rien ;
#   - il ne vaut que quelques minutes, et une seule fois.
#
# La limite connue est ailleurs : sur Android, un lien `sportsscope://` peut être
# capté par n'importe quelle appli qui déclare le même schéma. C'est pourquoi la durée
# est courte et l'usage unique. La vraie parade est l'App Link vérifié (lien https, que
# seule l'appli signée par la bonne clé peut recevoir) — déjà déclaré côté appli, actif
# dès que /.well-known/assetlinks.json publie l'empreinte de signature.
class SessionHandoff < ApplicationRecord
  belongs_to :user

  # Assez pour traverser un tap et le démarrage de l'appli, trop peu pour qu'un jeton
  # égaré serve plus tard.
  TTL = 5.minutes

  # Émet un jeton pour cet utilisateur et renvoie sa forme EN CLAIR — la seule fois
  # où elle existe. La base n'en garde que l'empreinte.
  def self.issue!(user)
    purge_expired

    token = SecureRandom.urlsafe_base64(16)
    create!(user: user, token_digest: digest(token), expires_at: TTL.from_now)
    token
  end

  # Échange un jeton contre son utilisateur, définitivement.
  #
  # L'usage unique tient à l'UPDATE conditionnel : deux requêtes concurrentes portant
  # le même jeton n'en verront qu'une modifier une ligne, l'autre repartira bredouille.
  # Un `find` suivi d'un `update` laisserait la fenêtre ouverte.
  #
  # Renvoie `nil` pour un jeton inconnu, périmé ou déjà utilisé — l'appelant traite
  # ces trois cas de la même façon : pas de session, et on continue en anonyme.
  def self.claim!(token)
    return nil if token.blank?

    claimed = where(token_digest: digest(token), consumed_at: nil)
              .where(expires_at: Time.current..)
              .update_all(consumed_at: Time.current)
    return nil if claimed.zero?

    find_by(token_digest: digest(token))&.user
  end

  # Les jetons périmés n'ont plus aucune valeur : on les enlève à l'émission plutôt
  # que d'ajouter une tâche planifiée pour une table qui reste minuscule. Les jetons
  # consommés sont gardés le temps de leur péremption — leur ligne est ce qui empêche
  # une deuxième tentative de créer un doublon.
  def self.purge_expired
    where(expires_at: ...Time.current).delete_all
  end

  def self.digest(token)
    Digest::SHA256.hexdigest(token)
  end
end
