namespace :keycloak do
  desc "Génère deploy/keycloak/realm-roles.txt depuis config/roles.json (source de vérité des rôles)"
  task :export_roles do
    require "json"

    roles_path = File.expand_path("../../config/roles.json", __dir__)
    out_path   = File.expand_path("../../deploy/keycloak/realm-roles.txt", __dir__)

    names = JSON.parse(File.read(roles_path)).keys
    File.write(out_path, names.join("\n") + "\n")
    puts "realm-roles.txt: #{names.size} rôles (#{names.join(', ')})"
  end
end
