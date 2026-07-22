# Nom lisible d'un matériel Strava (chaussures), résolu via `/gear/:id` et mis en
# cache : les résumés d'activité ne portent que le `gear_id`. Alimente le menu de
# filtre « Matériel » de la liste des activités. Les vélos gardent leur table
# `bikes` dédiée (chaînes / cirage) ; cette table ne stocke que les chaussures.
class StravaGear < ApplicationRecord
  belongs_to :user

  validates :gear_id, presence: true, uniqueness: { scope: :user_id }
  validates :name, presence: true
end
