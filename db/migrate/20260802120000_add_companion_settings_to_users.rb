# Le tableau de bord de l'application compagnon, décrit par le site.
#
# Un document JSON par utilisateur, et non une table de profils : l'appli récupère
# le document ENTIER en une requête (`/api/companion_settings`), le met en cache sur
# le téléphone, et le futur éditeur web éditera lui aussi le document entier. Une
# table par profil ferait payer des jointures pour reconstituer à chaque fois la
# même chose, sans jamais qu'on ait besoin de lire un profil isolément.
#
# `{}` = rien de réglé, ce qui est le cas de tout le monde au départ : le modèle
# sert alors ses profils par défaut (cf. `CompanionSettings`), pour que l'appli voie
# quelque chose d'utile avant même que l'éditeur existe.
class AddCompanionSettingsToUsers < ActiveRecord::Migration[8.1]
  def change
    add_column :users, :companion_settings, :jsonb, default: {}, null: false
  end
end
