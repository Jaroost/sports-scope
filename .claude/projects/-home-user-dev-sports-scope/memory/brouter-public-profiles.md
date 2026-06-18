---
name: brouter-public-profiles
description: Profils de routage disponibles (et absents) sur l'instance publique brouter.de
metadata:
  type: reference
---

L'instance publique `https://brouter.de/brouter` (défaut de `VITE_BROUTER_URL`) n'a qu'un sous-ensemble de profils installés. Vérifié le 2026-06-18 :

- Disponibles (HTTP 200) : `trekking`, `gravel`, `hiking-beta`, `hiking-mountain`.
- **Absents** (HTTP 500, corps vide) : tous les profils alpins SAC — `Hiking-Alpine-SAC6`, `Hiking-Mountain-SAC6`, `hiking-alpine`, etc.

Le créateur d'itinéraire mappe la catégorie d'activité → profil BRouter dans `BROUTER_PROFILES` (`app/javascript/components/RouteBuilder.vue`) : cycling→trekking, mtb→gravel, hiking→hiking-mountain. Pour utiliser un profil SAC plus permissif, il faut une instance BRouter auto-hébergée avec ces profils, pointée via `VITE_BROUTER_URL`.

Tester un profil : `curl -s -o /dev/null -w "%{http_code}" "https://brouter.de/brouter?lonlats=7.45,46.95|7.46,46.96&profile=NOM&format=geojson"`.
