class OpenedRoute < ApplicationRecord
  # Un utilisateur connecté a ouvert l'itinéraire (partagé) de quelqu'un d'autre.
  # Cf. RoutesController#shared, qui crée/rafraîchit la ligne, et #index, qui
  # les liste dans la catégorie « récemment ouverts » du sélecteur de navigation.
  belongs_to :user
  belongs_to :route
end
