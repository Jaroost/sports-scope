# Le dernier APK de l'application compagnon (dépôt voisin `sports-scope-companion`),
# décrit par un manifeste déposé à côté du binaire par `script/push-apk.sh`.
#
# Pourquoi des fichiers et pas la base ni `public/` :
#
# - l'APK ne sort pas de ce dépôt mais du dépôt Flutter, et ne peut donc pas voyager
#   dans l'image Docker — ce serait ~19 Mo par couche et un redéploiement complet du
#   site pour livrer une version de l'app ;
# - `public/` reçoit un an d'expiration (`config.public_file_server.headers`,
#   environments/production.rb) : un fichier au nom stable y resterait figé chez
#   Cloudflare et dans les navigateurs, exactement le piège que
#   `service_worker_cache.rb` corrige déjà ;
# - une ligne en base demanderait une migration et une console de prod pour publier,
#   là où un manifeste à côté du binaire se remplace d'un `scp`.
#
# Le dossier vit dans un volume Docker (cf. deploy/docker-compose.prod.yml) : il
# survit aux redéploiements, et son absence est un état normal — tant que rien n'a
# été poussé, `current` rend `nil` et la page le dit.
class CompanionRelease
  MANIFEST_NAME = "manifest.json".freeze

  attr_reader :version_name, :version_code, :filename, :size, :sha256, :released_at

  class << self
    def dir
      Pathname.new(ENV.fetch("COMPANION_APK_DIR") { Rails.root.join("storage/companion").to_s })
    end

    # Rend la version publiée, ou `nil` s'il n'y en a pas (dossier vide, manifeste
    # illisible, binaire absent). Jamais d'exception : la page de téléchargement et
    # l'endpoint de version doivent répondre même quand rien n'est publié.
    def current
      manifest = dir.join(MANIFEST_NAME)
      return nil unless manifest.file?

      release = new(JSON.parse(manifest.read))
      release.available? ? release : nil
    rescue JSON::ParserError, SystemCallError => e
      Rails.logger.warn("[companion] manifeste illisible (#{manifest}) : #{e.message}")
      nil
    end
  end

  def initialize(data)
    @version_name = data["version_name"].to_s
    @version_code = data["version_code"].to_i
    # `basename` : le manifeste est un fichier du serveur, mais il désigne le chemin
    # qu'on va servir. Un `../` qui s'y glisserait ferait sortir `send_file` du volume.
    @filename = File.basename(data["file"].to_s)
    @size = data["size"].to_i
    @sha256 = data["sha256"].to_s
    @released_at = parse_time(data["released_at"])
  end

  def path
    self.class.dir.join(filename)
  end

  def available?
    version_code.positive? && filename.present? && filename != "." && path.file?
  end

  # Ce que l'application interroge au lancement. Volontairement sans donnée
  # d'utilisateur : l'endpoint est public (cf. CompanionController#version).
  def as_json(*)
    {
      version_name: version_name,
      version_code: version_code,
      size: size,
      sha256: sha256,
      released_at: released_at&.iso8601,
    }
  end

  private

  def parse_time(value)
    Time.zone.parse(value.to_s)
  rescue ArgumentError, TypeError
    nil
  end
end
