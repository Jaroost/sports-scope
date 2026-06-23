---
name: offline-maps-navigation
description: Comment marche le mode carte hors-ligne de la navigation (PMTiles swisstopo gris)
metadata:
  type: project
---

La navigation (`RouteNavigation.vue`) a un mode hors-ligne : pré-téléchargement du corridor
du trajet en **fond swisstopo gris uniquement**, empaqueté en une archive **PMTiles** par
trajet, stockée en **OPFS**, lue par MapLibre via le protocole `pmtiles://`.

**Pourquoi swisstopo gris uniquement :** c'est le seul fond utilisé en nav dont les CGU
autorisent le hors-ligne (géodonnées OGD swisstopo : gratuites, commerciales OK,
redistribution OK, seule condition `© swisstopo`). CyclOSM et OpenTopoMap **interdisent** le
pré-téléchargement (OSM tile usage policy) ; le WMTS swisstopo a un fair use (~20 req/min
moyen) → on télécharge un corridor par trajet, throttlé (6 req simultanées), pas plus.

**Code :** `app/javascript/offline/` — `pmtilesWriter.ts` (writer PMTiles v3 maison, valide
contre le lecteur `pmtiles`, réutilise son `zxyToTileId`), `tileMath.ts` (tuiles du
corridor), `offlineMaps.ts` (download/OPFS/protocole/style). UI : `NavOfflineButton.vue`
(injecté dans `NavControlsPanel` via slot `#map-extra`). Le fond local n'est utilisé QUE
quand `navigator.onLine === false` (en ligne le WMTS reste préféré). Le `service-worker.js`
cache page+assets+JSON du trajet (`/api/routes/shared/`) pour que la nav se lance offline.

**Limites connues :** OPFS `createWritable` requis (dégrade en masquant le bouton). Défauts :
zoom 10→16, buffer 400 m (~13 Mo / 50 km). Évolution possible : génération PMTiles côté
serveur pour mutualiser entre appareils.
