module NavbarHelper
  # Définition de chaque menu configurable de la barre de navigation : icône FontAwesome,
  # clé i18n du libellé et helper de chemin. Les clés doivent correspondre à
  # User::NAVBAR_ITEM_KEYS (et à la carte d'icônes de UserProfile.vue).
  NAVBAR_ITEM_DEFS = {
    "dashboard" => { icon: "fa-gauge-high", label: "nav.dashboard", path: :dashboard_path },
    "performance" => { icon: "fa-trophy", label: "nav.performance", path: :performance_path },
    "routes" => { icon: "fa-route", label: "nav.routes", path: :routes_index_path },
    "new_route" => { icon: "fa-map-location-dot", label: "nav.new_route", path: :new_route_path },
    "free_navigate" => { icon: "fa-location-crosshairs", label: "nav.free_navigate", path: :free_navigate_path },
    "chains" => { icon: "fa-link", label: "nav.chains", path: :chains_path },
  }.freeze

  # Menus visibles dans la barre de navigation, dans l'ordre choisi par l'utilisateur.
  # Retourne une liste de hash { key:, icon:, label:, path: }.
  def navbar_menu_items(user)
    resolved_menu_items(user) { |item| item["visible"] }
  end

  # Menus à afficher en boutons sur la page d'accueil (rootpath), dans l'ordre choisi.
  # Pilotés par l'interrupteur `home`, indépendant de la visibilité dans la navbar.
  def home_menu_items(user)
    resolved_menu_items(user) { |item| item["home"] }
  end

  private

  # Résout les items de navbar de l'utilisateur en hash prêts à rendre, en ne gardant
  # que ceux retenus par le bloc (drapeau `visible` ou `home`) et de clé connue.
  def resolved_menu_items(user)
    user.navbar_items.filter_map do |item|
      next unless yield(item)
      defn = NAVBAR_ITEM_DEFS[item["key"]]
      next unless defn
      { key: item["key"], icon: defn[:icon], label: t(defn[:label]), path: public_send(defn[:path]) }
    end
  end
end
