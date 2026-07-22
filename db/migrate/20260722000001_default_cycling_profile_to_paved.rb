# Le profil de routage vélo par défaut passe de `trekking` à `trekking-paved`.
#
# `trekking` ne regarde presque pas le revêtement : une piste cyclable, un itinéraire
# cyclable longue distance et une route de grade1 y coûtent tous 1.0, goudronnés ou non.
# D'où des sorties route qui partent sur du chemin blanc — courant en Suisse, où beaucoup
# d'itinéraires Veloland ne sont pas revêtus. Mesuré sur quatre itinéraires Jura/Seeland :
# 15,8 % de non-bitumé avec `trekking`, 1,8 % avec `trekking-paved`, pour 13 % de distance
# en plus (cf. deploy/brouter/profiles/trekking-paved.brf).
#
# Changer User::DEFAULT_PREFERENCES ne suffit pas : `RestructurePreferencesPerSport` a
# écrit "trekking" en dur dans les préférences de chaque compte existant. Sans cette
# migration, le nouveau défaut ne toucherait que les comptes créés ensuite.
#
# On ne réécrit QUE la valeur exacte "trekking" : un compte ayant choisi `fastbike` ou
# `shortest` garde son choix. Reste le cas indistinguable de l'utilisateur qui aurait
# délibérément sélectionné `trekking` — la valeur backfillée et la valeur choisie sont
# identiques en base, rien ne permet de les séparer. Le repli reste à un clic dans le
# profil, et `down` rétablit l'état d'origine.
class DefaultCyclingProfileToPaved < ActiveRecord::Migration[8.1]
  FROM = "trekking".freeze
  TO = "trekking-paved".freeze

  def up
    swap(FROM, TO)
  end

  def down
    swap(TO, FROM)
  end

  private

  # jsonb_set n'écrit que si le chemin existe déjà — les comptes sans préférence vélo
  # enregistrée sont laissés tels quels et suivront simplement le nouveau défaut du modèle.
  def swap(from, to)
    execute(<<~SQL.squish)
      UPDATE users
      SET preferences = jsonb_set(
            preferences, '{sports,cycling,route_profile}', #{connection.quote(to.to_json)}::jsonb, false)
      WHERE preferences #>> '{sports,cycling,route_profile}' = #{connection.quote(from)}
    SQL
  end
end
