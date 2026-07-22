# Sans `expire_after`, le cookie de session meurt à la fermeture du navigateur : le
# « remember me » de Keycloak évite alors de retaper son mot de passe, mais il faut
# quand même recliquer sur « se connecter ». On aligne la durée sur le remember-me
# du realm (30 jours, cf. deploy/keycloak/docker-entrypoint.sh).
Rails.application.config.session_store :cookie_store,
  key: "_sports_scope_session",
  expire_after: 30.days,
  secure: Rails.env.production?,
  same_site: :lax
