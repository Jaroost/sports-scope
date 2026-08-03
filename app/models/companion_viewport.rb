# La place que le tableau de bord de l'application a réellement pour sa grille.
#
# Ce que l'éditeur compose se décrit en lignes et en colonnes ; ce qui décide de
# ce qu'un composant peut y dessiner, ce sont des pixels. Sans cette mesure, le
# site suppose un téléphone de référence — un avertissement plausible, pas vrai.
#
# **C'est la grille et non l'écran.** L'appli mesure le rectangle que reçoit
# vraiment une page de grille (`DashboardPage._grid`), barre système, en-tête et
# bandeau du bas déjà retirés. Renvoyer la taille de l'écran obligerait à
# recalculer ici une soustraction qui vit là-bas, et qui dériverait au premier
# changement de mise en page du dépôt voisin.
#
# En pixels **logiques** : ce sont ceux des seuils de `BlockMetrics`, et les
# seuls qui veulent dire quelque chose — le même téléphone en 1080 physiques
# dessine la même chose qu'en 2160 sur un écran deux fois plus dense.
module CompanionViewport
  # Les bornes du plausible. Elles ne cherchent pas à deviner un modèle de
  # téléphone : elles écartent ce qui ne peut pas être une mesure — un zéro d'une
  # mise en page pas encore posée, une valeur farfelue d'un appelant qui n'est
  # pas l'appli. En dehors, on garde ce qu'on avait plutôt que d'écrire n'importe
  # quoi.
  MIN = 120
  MAX = 4000

  # `"328x598"` → `{ "width" => 328, "height" => 598 }`, `nil` sinon.
  #
  # Une seule chaîne et non deux paramètres : c'est une mesure indivisible, et
  # une largeur arrivée sans sa hauteur ne veut rien dire.
  def self.parse(raw)
    match = /\A(\d{2,4})x(\d{2,4})\z/.match(raw.to_s)
    return nil unless match

    width = match[1].to_i
    height = match[2].to_i
    return nil unless width.between?(MIN, MAX) && height.between?(MIN, MAX)

    { "width" => width, "height" => height }
  end

  # Le téléphone ordinaire dont le site se contente tant qu'aucun n'a parlé :
  # 360 × 800 px logiques, moins la barre système, le bandeau du bas, l'en-tête
  # de page et les marges. **Recopié dans `companionSettings.ts`** (`PHONE_GRID`),
  # qui en a besoin avant même de recevoir les props.
  DEFAULT = { "width" => 328, "height" => 598 }.freeze
end
