# Spec d'un profil de routage : `base` ou `base~variable=valeur~…` (cf. routingProfile.ts,
# dont c'est le miroir). Le catalogue des variables réglables est le même fichier JSON que
# celui du front, qui sert ici de liste blanche : une variable ou une valeur hors catalogue
# est retirée, jamais transmise à BRouter.
module RoutingProfileSpec
  SEPARATOR = "~".freeze
  CATALOG = JSON.parse(Rails.root.join("app/javascript/routingProfileParams.json").read).freeze
  PARAMS = CATALOG.fetch("params")
  PROFILES = CATALOG.fetch("profiles")
  MAX_LENGTH = 400

  module_function

  def base(spec)
    spec.to_s.split(SEPARATOR, 2).first.to_s
  end

  # Forme canonique du spec, ou nil si le profil de base n'est pas dans `allowed_bases`.
  # Les surcharges inconnues ou égales au défaut sont retirées (même règle que `buildSpec`).
  def normalize(spec, allowed_bases)
    spec = spec.to_s
    return nil if spec.length > MAX_LENGTH
    base, *rest = spec.split(SEPARATOR)
    return nil unless allowed_bases.include?(base)

    keys = PROFILES.dig(base, "params") || []
    given = rest.filter_map do |part|
      key, raw = part.split("=", 2)
      next unless keys.include?(key)
      value = coerce(key, raw)
      [ key, value ] unless value.nil?
    end.to_h

    parts = keys.sort.filter_map do |key|
      next unless given.key?(key)
      next if given[key] == default_for(base, key)
      "#{key}=#{format_value(given[key])}"
    end
    [ base, *parts ].join(SEPARATOR)
  end

  def default_for(base, key)
    defaults = PROFILES.dig(base, "defaults") || {}
    value = defaults.key?(key) ? defaults[key] : PARAMS.dig(key, "default")
    value.is_a?(Numeric) ? value.to_f : value
  end

  def coerce(key, raw)
    def_ = PARAMS[key]
    return nil unless def_
    case def_["type"]
    when "bool"
      { "true" => true, "false" => false }[raw.to_s]
    when "choice"
      n = Float(raw.to_s, exception: false)
      n && def_["values"].include?(n) ? n : nil
    else
      n = Float(raw.to_s, exception: false)
      n && n.clamp(def_["min"], def_["max"])
    end
  end

  # Entier sans décimale (`10000`, pas `10000.0`), comme le front l'écrit.
  def format_value(value)
    return value.to_s if value == true || value == false
    value == value.to_i ? value.to_i.to_s : value.to_s
  end
end
