# Be sure to restart your server when you modify this file.

# Sert le manifest PWA avec le bon Content-Type. Sans ça, ActionDispatch::Static
# ne connaît pas l'extension `.webmanifest` et renvoie `text/plain`, ce que
# Chrome peut refuser (manifest ignoré → site non installable).
Rack::Mime::MIME_TYPES[".webmanifest"] = "application/manifest+json"

# APK de l'app compagnon (CompanionController#download). Sans ça, Rack ne connaît pas
# l'extension et le `type:` explicite de `send_file` serait la seule chose à porter le
# bon Content-Type — on le déclare ici aussi pour que tout chemin qui servirait le
# fichier (ActionDispatch::Static compris) l'annonce comme un paquet Android, faute de
# quoi Chrome télécharge un `application/octet-stream` qu'il n'enchaîne pas sur
# l'installateur au tap de la notification.
Rack::Mime::MIME_TYPES[".apk"] = "application/vnd.android.package-archive"
