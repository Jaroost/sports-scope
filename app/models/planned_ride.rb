# Itinéraire accroché à un jour : la brique qui permet de composer sa semaine à
# l'avance et de voir, sur la barre de charge, ce qui est prévu (orange) entre ce
# qui est fait (vert) et ce qui reste à placer (gris).
#
# Le TSS estimé n'est VOLONTAIREMENT pas stocké ici. Il dépend de seuils
# modifiables (FTP, poids, vitesse moyenne du profil) : figé à la planification, il
# deviendrait faux au premier changement de seuil, et la liste des itinéraires
# afficherait alors un autre chiffre que le planificateur pour le même itinéraire.
# On sert donc les dimensions de l'itinéraire (distance, D+, sport) et le front
# recalcule avec `estimateRouteLoad` (routeLoad.ts) — la même fonction que partout
# ailleurs, donc une seule source de vérité.
#
# Pas de colonne `status` non plus : « fait » se déduit de la date. Le vert de la
# barre est le TSS RÉEL de la série (activités effectivement enregistrées), et
# l'orange ne concerne que les jours à venir — aucun rapprochement plan ↔ activité
# à faire, donc aucune heuristique d'appariement à se tromper.
class PlannedRide < ApplicationRecord
  belongs_to :user
  belongs_to :route

  validates :planned_on, presence: true
end
