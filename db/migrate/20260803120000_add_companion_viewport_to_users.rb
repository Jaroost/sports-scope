# La taille de la grille du tableau de bord, telle que le téléphone la mesure.
#
# L'éditeur compose en lignes et en colonnes, mais ce qui décide de ce qu'un
# composant peut dessiner, ce sont des pixels — et le site n'en savait rien. Il
# supposait donc un téléphone de référence (328 × 598 px logiques pour la
# grille), ce qui rend un avertissement plausible plutôt que vrai.
#
# L'appli renvoie maintenant ce qu'elle a **réellement mesuré** en posant une
# page de grille, et le site s'en sert pour dimensionner ses aperçus.
#
# `null` et pas une valeur par défaut : « jamais mesuré » est exactement la
# distinction dont l'éditeur a besoin — il annonce alors un téléphone ordinaire
# au lieu de prétendre connaître celui de l'utilisateur.
class AddCompanionViewportToUsers < ActiveRecord::Migration[8.1]
  def change
    add_column :users, :companion_viewport, :jsonb
  end
end
