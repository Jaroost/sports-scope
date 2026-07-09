class ChangeRouteProfileDefault < ActiveRecord::Migration[8.1]
  # La colonne `routes.profile` était vestigiale (défaut "cycling", jamais utilisée
  # pour router). Elle stocke désormais le vrai profil de routage BRouter (cf.
  # brouter.ts / PROFILES_BY_SPORT). On passe le défaut à "trekking" et on rétablit
  # les valeurs héritées (cycling/foot/driving) au défaut du sport de l'itinéraire.
  DEFAULTS = { "cycling" => "trekking", "mtb" => "gravel", "hiking" => "hiking-mountain" }.freeze
  LEGACY = %w[cycling foot driving].freeze

  def up
    change_column_default :routes, :profile, from: "cycling", to: "trekking"

    DEFAULTS.each do |activity, profile|
      execute(<<~SQL.squish)
        UPDATE routes SET profile = #{connection.quote(profile)}
        WHERE activity = #{connection.quote(activity)}
          AND profile IN (#{LEGACY.map { |v| connection.quote(v) }.join(', ')})
      SQL
    end
  end

  def down
    change_column_default :routes, :profile, from: "trekking", to: "cycling"
  end
end
