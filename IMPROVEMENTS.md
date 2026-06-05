# Pistes d'amélioration — sports-scope

Notes de brainstorming après la décomposition de `ActivityDetail.vue`.
Classées par impact / effort. Vue surtout côté « détail d'activité » + dashboard.

## Quick wins (≤ 1 jour chacun)

### Le TODO en haut d'`ActivityDetail` : scroll molette qui bloque la page
Carte + graphes mangent la molette. Pattern standard : « cooperative gestures » —
molette nue scrolle la page, **Ctrl/⌘ + molette** zoome. MapLibre a
`cooperativeGestures: true` natif (overlay « Use Ctrl + scroll to zoom »).
Pour Chart.js, gate le `handleZoomWheel` sur `e.ctrlKey || e.metaKey` avant le
`preventDefault`.

### PRs visibles aussi sur la liste
Aujourd'hui le badge 🏆 n'apparaît qu'en ouvrant l'activité. Dans
`HelloStrava.vue` / `ImportFitActivity.vue`, un appel groupé du genre
`/api/peak_power_ranks/summary` qui te dit pour chaque activité combien de
records elle contient (≥1 → petit 🏆 sur la ligne).

### Zones de puissance (FTP)
La table peak-power existe déjà mais sans contexte. Ajouter une préférence
utilisateur `ftp_watts`, et colorer chaque ligne par zone (Z1–Z7 Coggan) ou
afficher le `% FTP`. Sans ça l'utilisateur ne sait pas si « 270 W sur 1h » est
bon pour lui.

### Calendrier mensuel sur le dashboard
La liste linéaire est limitée pour repérer le rythme d'entraînement. Une
heatmap GitHub-style (52 semaines, intensité par distance ou TSS) prend une
seule grille SVG, pas de dépendance.

## Features moyennes (1-3 jours)

### Comparaison de deux activités
Sélectionne deux activités → graphes superposés (même tracé ou pas), tableaux
côte à côte. Cas d'usage classique : « je refais le même col, suis-je en
progrès ? ». La logique de tooltip est déjà extraite, donc très réutilisable.

### Training Load (CTL/ATL/TSB)
Calcul des moyennes glissantes 42j/7j sur le TSS journalier (ou kJ si pas de
puissance). Une page `/training` avec un graphe Chart.js qui montre
forme/fatigue. C'est LA métrique que TrainingPeaks/intervals.icu valorisent et
que Strava facture.

### Détection de segments récurrents
Quand l'utilisateur emprunte plusieurs fois le même tronçon, regrouper les
passages : « tu as fait ce bout de route 7 fois, ton meilleur temps : 4:32 ».
PostGIS rendrait ça super propre (`ST_DWithin` sur des points discrétisés).
Strava-segments-killer-feature sans payer.

### Webhooks Strava
Aujourd'hui la liste se rafraîchit à la main. Strava propose des webhooks
(push). Setup non trivial (verify token + endpoint public) mais une fois
branché, les nouvelles activités apparaissent sans cliquer.

## Architecture / dette technique

### Tests automatisés
Je n'ai vu aucun fichier dans `test/` ou `spec/`. Avec la refacto qu'on vient
de faire, un fix qui casse `ActivityCharts` sans rien indiquer est trop
facile. Au minimum :
- Tests Ruby (Minitest, déjà dans Rails) sur `PeakPowerCurve.compute_from` et
  `bests_for_user` — ce sont des fonctions pures, faciles à couvrir.
- Un smoke test E2E (Capybara + Playwright) qui charge `/activities/:id`,
  attend que la carte rend et qu'au moins un graphe a un canvas — bloque les
  régressions visuelles type « map FIT ne s'affiche pas ».

### Peak power en background job
Actuellement `compute_peak_powers!` tourne dans le request cycle au moment de
l'upload. Avec ActiveJob (Solid Queue / GoodJob), ça passe en async + on peut
backfill une grosse base sans bloquer.

### `ActivityCharts.vue` est encore gros (~1700 l)
Trois sous-blocs autonomes dedans : `RangeChips`, `PresetBar`, `ChartLayout`.
Découpe future si ça continue à grossir.

### Cache Strava en DB plutôt que `Rails.cache`
Les `strava:activities:#{user_id}` expirent à 1 jour et sont volatiles
(perdues sur restart). Une table `cached_strava_activities` permettrait :
pré-chargement à la première visite, suivi des changements, et la base pour
les calendriers / training load multi-activités.

## Cycling-spécifique (côté valeur produit)

### eFTP automatique
Estime le FTP depuis la peak-power curve (best 20-min × 0.95, ou
Monod-Scherrer sur les pics 3-20 min). Affiche-le sur le dashboard et
utilise-le comme défaut pour les zones.

### VAM percentile vs son propre historique
Sur la table des montées : « VAM dans le top 10 % de tes ascensions cette
saison ». Réutilise l'infra `bests_for_user`.

### Météo a posteriori
API Open-Meteo historique (gratuit) : pour chaque activité, récupère la
température / pluie / vent moyens. Affichage en pill sur la ligne du
dashboard. Bon contexte pour comprendre une mauvaise perf.

### Aerobic decoupling
Ratio puissance/FC première moitié vs seconde moitié de l'activité.
Indicateur classique d'endurance de base. Calcul trivial avec les streams
qu'on a déjà.

## Top 3 pour cette semaine

Si je devais prioriser trois éléments faible effort / gros impact :

1. **Scroll molette** (le TODO existant) — UX bloquante au quotidien.
2. **FTP + zones de puissance** — donne du sens à la table peak-power qu'on
   vient de construire.
3. **Tests sur `PeakPowerCurve`** — protège la dette technique récente.
