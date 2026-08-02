# Courbe mean-max de fréquence cardiaque par activité — la jumelle cardio de
# `peak_powers`. Même nature : un dérivé INTRINSÈQUE de la sortie (la meilleure FC
# moyenne tenue sur 20 min / ~1 h), indépendant des seuils de l'athlète, donc
# stocké une fois et relu à volonté.
#
# Sans cette colonne, `LthrEstimator` ne pouvait tourner qu'avec les streams en
# main — c'est-à-dire sur la page d'une activité — et le seuil cardiaque de
# l'athlète devait se contenter d'un proxy grossier (max des FC MOYENNES ÷ 0,92
# × 0,9). La courbe persistée permet l'agrégation sur une fenêtre glissante, exactement
# comme `FtpEstimator` le fait déjà pour la puissance.
#
# {} = streams sans canal cardio, ou sortie plus courte que 20 min.
class AddPeakHeartratesToActivities < ActiveRecord::Migration[8.1]
  def change
    add_column :strava_activities, :peak_heartrates, :jsonb, default: {}, null: false
    add_column :imported_activities, :peak_heartrates, :jsonb, default: {}, null: false
  end
end
