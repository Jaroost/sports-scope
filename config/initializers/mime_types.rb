# Be sure to restart your server when you modify this file.

# Sert le manifest PWA avec le bon Content-Type. Sans ça, ActionDispatch::Static
# ne connaît pas l'extension `.webmanifest` et renvoie `text/plain`, ce que
# Chrome peut refuser (manifest ignoré → site non installable).
Rack::Mime::MIME_TYPES[".webmanifest"] = "application/manifest+json"
