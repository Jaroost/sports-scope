# Les profils de sortie de l'application compagnon (dépôt voisin
# `sports-scope-companion`).
#
# Un profil décrit un tableau de bord : ses pages dans l'ordre, ce que chacune
# contient et comment, les jeux de valeurs du bandeau, les capteurs utilisés et les
# réglages radar / éclairage. Le cycliste en choisit un au départ — on sait sur quel
# vélo on monte au moment où l'on monte dessus.
#
# **Le contrat est partagé avec le dépôt voisin** : les clés de composants
# (`metric`, `zones`, …), de modes (`big`, `bar_only`, …) et de mesures (`speed`,
# `power_np`, …) sont celles de `lib/dashboard/` côté Dart. Y toucher demande de
# modifier les deux dépôts.
#
# Ce qui rend l'exercice tenable : **l'appli ne fait jamais confiance à ce
# document**. Elle ignore toute clé qu'elle ne connaît pas, retombe sur son tableau
# de bord intégré si rien n'est exploitable, et garantit elle-même ce que le format
# ne peut pas dire (au plus une carte, quatre cases de bandeau, pas de cellules qui
# se recouvrent). On peut donc servir un profil un peu en avance sur la version
# installée sans casser la sortie de personne.
module CompanionSettings
  module_function

  # La version du document. Sert à l'appli pour décider quoi faire d'un format
  # futur ; elle n'a encore jamais changé.
  VERSION = 1

  # Ce qu'on sert tant que l'utilisateur n'a rien réglé.
  #
  # Trois profils et pas un seul : c'est l'écart entre les pratiques qui justifie
  # tout ce chantier, et un unique profil par défaut ne le montrerait pas. Le
  # sélecteur de départ ne s'affiche d'ailleurs qu'à partir de deux.
  def defaults
    { "v" => VERSION, "presets" => [ road, mtb, trainer ] }
  end

  # Le document d'un utilisateur, ou les profils par défaut.
  #
  # Un document vide n'est pas un choix : c'est l'état initial de tous les comptes.
  # Servir `{}` obligerait l'appli à distinguer « ce compte n'a pas de profils » de
  # « le site n'a rien su dire », alors que la réponse utile est la même dans les
  # deux cas.
  def for(user)
    stored = user.companion_settings
    return defaults if stored.blank? || stored["presets"].blank?

    stored
  end

  # Route : la carte d'abord, l'effort ensuite, les chiffres en grille.
  def road
    {
      "key" => "road",
      "name" => "Route",
      "pages" => [
        { "kind" => "map" },
        {
          "kind" => "list", "title" => "Effort",
          "blocks" => [
            { "kind" => "recording", "mode" => "full" },
            { "kind" => "zones", "source" => "hr", "mode" => "bar" },
            { "kind" => "zones", "source" => "power", "mode" => "bar" },
            { "kind" => "averages", "mode" => "cards" }
          ]
        },
        {
          "kind" => "grid", "title" => "Chiffres", "rows" => 3, "cols" => 3,
          "cells" => [
            { "row" => 0, "col" => 0, "block" => metric("speed", "big") },
            { "row" => 0, "col" => 1, "block" => metric("distance", "compact") },
            { "row" => 0, "col" => 2, "block" => metric("ascent", "compact") },
            # La ligne du milieu fusionnée : la barre des zones garde toute son
            # information sans sa légende, qui ne tiendrait pas dans une cellule.
            { "row" => 1, "col" => 0, "col_span" => 3,
              "block" => { "kind" => "zones", "source" => "power", "mode" => "bar_only" } },
            { "row" => 2, "col" => 0, "block" => metric("power", "zone") },
            { "row" => 2, "col" => 1, "col_span" => 2, "block" => metric("heart_rate", "gauge") }
          ]
        }
      ],
      "bands" => [
        band(%w[duration distance speed power]),
        band(%w[heart_rate hr_zone power power_zone])
      ]
    }
  end

  # VTT : mêmes capteurs, mais un seuil de proximité radar plus court — on n'y roule
  # pas à la même vitesse, et une alerte à 140 m sur un single-track ne veut rien
  # dire. Pas de page de listes : on n'y consulte pas ses moyennes.
  def mtb
    {
      "key" => "mtb",
      "name" => "VTT",
      "pages" => [
        { "kind" => "map" },
        {
          "kind" => "grid", "title" => "Effort", "rows" => 2, "cols" => 2,
          "cells" => [
            { "row" => 0, "col" => 0, "block" => metric("heart_rate", "zone") },
            { "row" => 0, "col" => 1, "block" => metric("ascent", "big") },
            { "row" => 1, "col" => 0, "col_span" => 2,
              "block" => { "kind" => "recording", "mode" => "full" } }
          ]
        }
      ],
      "bands" => [
        band(%w[duration distance speed heart_rate]),
        band(%w[heart_rate hr_zone ascent cadence])
      ],
      "radar" => { "close_m" => 25, "range_m" => 80 }
    }
  end

  # Home-trainer : **pas de page carte du tout**.
  #
  # Ce n'est pas une carte qu'on masque, c'est un WebView qu'on ne charge pas : ni
  # pont, ni tuiles, ni service worker. Et pas de GPS non plus — donc pas de service
  # au premier plan ni de notification, pour une trace qui ne dirait rien. Le
  # baromètre et le radar suivent, pour les mêmes raisons.
  def trainer
    {
      "key" => "trainer",
      "name" => "Home-trainer",
      "pages" => [
        {
          "kind" => "grid", "title" => "Séance", "rows" => 2, "cols" => 2,
          "cells" => [
            { "row" => 0, "col" => 0, "col_span" => 2, "block" => metric("power", "zone") },
            { "row" => 1, "col" => 0, "block" => metric("cadence", "big") },
            { "row" => 1, "col" => 1, "block" => metric("heart_rate", "gauge") }
          ]
        },
        {
          "kind" => "list", "title" => "Séance",
          "blocks" => [
            { "kind" => "recording", "mode" => "full" },
            { "kind" => "zones", "source" => "power", "mode" => "bar" },
            { "kind" => "averages", "mode" => "cards" }
          ]
        }
      ],
      "bands" => [
        band(%w[duration power cadence heart_rate]),
        band(%w[power_avg power_np calories duration])
      ],
      "sensors" => {
        "gps" => false, "barometer" => false, "light" => false,
        "compass" => false, "radar" => false
      }
    }
  end

  def metric(key, mode)
    { "kind" => "metric", "metric" => key, "mode" => mode }
  end

  # Quatre mesures au plus : au-delà, les chiffres du bandeau deviennent trop petits
  # pour être lus d'un coup d'œil en roulant, ce qui est son seul usage. L'appli
  # tronque de son côté ; couper ici évite d'écrire un document qu'elle corrigera.
  def band(metrics)
    { "metrics" => metrics.first(4) }
  end
end
