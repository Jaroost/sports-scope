module NavbarHelper
  # Définition de chaque menu configurable de la barre de navigation : icône FontAwesome,
  # clé i18n du libellé et helper de chemin. Les clés doivent correspondre à
  # User::NAVBAR_ITEM_KEYS (et à la carte d'icônes de UserProfile.vue).
  NAVBAR_ITEM_DEFS = {
    "dashboard" => { icon: "fa-gauge-high", label: "nav.dashboard", path: :dashboard_path },
    "routes" => { icon: "fa-route", label: "nav.routes", path: :routes_index_path },
    "new_route" => { icon: "fa-map-location-dot", label: "nav.new_route", path: :new_route_path },
    "free_navigate" => { icon: "fa-location-crosshairs", label: "nav.free_navigate", path: :free_navigate_path },
    "chains" => { icon: "fa-link", label: "nav.chains", path: :chains_path },
  }.freeze

  # Menus visibles de l'utilisateur, dans son ordre choisi, prêts à rendre.
  # Retourne une liste de hash { key:, icon:, label:, path: }.
  def navbar_menu_items(user)
    user.navbar_items.filter_map do |item|
      next unless item["visible"]
      defn = NAVBAR_ITEM_DEFS[item["key"]]
      next unless defn
      { key: item["key"], icon: defn[:icon], label: t(defn[:label]), path: public_send(defn[:path]) }
    end
  end
end
