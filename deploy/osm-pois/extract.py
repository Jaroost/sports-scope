#!/usr/bin/env python3
"""Transforme la sortie `osmium export -f geojsonseq` en CSV chargeable par COPY.

Lit un flux GeoJSON Text Sequences sur stdin, écrit `category,name,lat,lng,country`
sur stdout (une ligne par POI retenu), et un résumé par catégorie sur stderr.

`--country XX` : code ISO 3166-1 alpha-2 de l'extrait traité (sync.sh appelle ce
script une fois par extrait, cf. COUNTRY_CODES). OSM ne porte pas le pays sur les
objets ; l'extrait dont ils viennent est la seule source disponible ici. Vide (ou
option absente) => colonne NULL.

C'est ici que vit la classification des éléments OSM, déplacée de
GeocodesController#classify_poi : la catégorie est calculée une fois à l'import
plutôt qu'à chaque requête. Les valeurs produites doivent rester alignées sur les
`serverTypes` du registre front (app/javascript/poiCategories.ts).

Le `lat`/`lng` d'une géométrie non ponctuelle (way : boulangerie, cimetière,
restaurant en polygone) est le centre de sa bounding box — même sémantique que le
`out center` d'Overpass qu'on remplace.
"""

import argparse
import json
import sys
from collections import Counter

PLACE_TYPES = {"city", "town", "village", "hamlet"}


def classify(tags):
    """Catégorie POI d'un élément OSM d'après ses tags, ou None s'il est ignoré.

    L'ordre des tests est significatif et reprend celui de l'ancien
    GeocodesController#classify_poi. Points de vue, sommets et cols sont regroupés
    sous "viewpoint" (une seule catégorie côté profil).
    """
    amenity = tags.get("amenity")

    if amenity == "grave_yard" or tags.get("landuse") == "cemetery":
        return "cemetery"
    if tags.get("shop") == "bakery":
        return "bakery"
    # Les sources ne sont retenues que si l'eau est potable — le filtre osmium ne
    # sait pas exprimer cette conjonction, elle était portée par la requête
    # Overpass (`node["natural"="spring"]["drinking_water"="yes"]`).
    if amenity == "drinking_water":
        return "water"
    if tags.get("natural") == "spring" and tags.get("drinking_water") == "yes":
        return "water"
    if amenity in ("cafe", "restaurant"):
        return "food"
    if (
        tags.get("tourism") == "viewpoint"
        or tags.get("natural") in ("peak", "saddle")
        or tags.get("mountain_pass") == "yes"
    ):
        return "viewpoint"
    if amenity == "toilets":
        return "toilets"
    if tags.get("tourism") == "picnic_site" or tags.get("leisure") == "picnic_table":
        return "picnic"
    if tags.get("place") in PLACE_TYPES:
        return tags["place"]

    return None


def bbox_center(geometry):
    """Centre de la bounding box d'une géométrie GeoJSON, ou None si illisible."""
    coords = geometry.get("coordinates")
    if coords is None:
        return None

    lngs, lats = [], []
    stack = [coords]
    while stack:
        node = stack.pop()
        if not isinstance(node, list) or not node:
            continue
        if isinstance(node[0], (int, float)):
            lngs.append(node[0])
            lats.append(node[1])
        else:
            stack.extend(node)

    if not lngs:
        return None
    return (min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2


def csv_field(value):
    """Échappement CSV minimal (le nom est le seul champ à risque)."""
    if '"' in value or "," in value or "\n" in value or "\r" in value:
        return '"' + value.replace('"', '""') + '"'
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--country", default="", help="code ISO 3166-1 alpha-2 de l'extrait")
    args = parser.parse_args()
    country = args.country.strip().upper()

    counts = Counter()
    skipped = 0
    out = sys.stdout

    for line in sys.stdin:
        # geojsonseq préfixe chaque enregistrement de RS (0x1e) selon la RFC 8142.
        line = line.strip("\x1e \t\r\n")
        if not line:
            continue

        try:
            feature = json.loads(line)
        except ValueError:
            skipped += 1
            continue

        tags = feature.get("properties") or {}
        category = classify(tags)
        if category is None:
            continue

        center = bbox_center(feature.get("geometry") or {})
        if center is None:
            skipped += 1
            continue
        lat, lng = center

        # name vide = NULL en base : le libellé par défaut est appliqué côté Rails
        # (GeocodesController::DEFAULT_POI_NAMES), qui connaît la locale.
        name = (tags.get("name") or "").strip()

        out.write(f"{category},{csv_field(name)},{lat:.7f},{lng:.7f},{country}\n")
        counts[category] += 1

    total = sum(counts.values())
    detail = ", ".join(f"{c}={n}" for c, n in sorted(counts.items()))
    print(f"[osm-pois] {total} POI extraits ({detail})", file=sys.stderr)
    if skipped:
        print(f"[osm-pois] {skipped} élément(s) illisible(s) ignoré(s)", file=sys.stderr)

    # Une extraction vide signale un pipeline cassé (filtre ou export) : on le
    # remonte pour que sync.sh n'écrase pas une table saine par une table vide.
    return 0 if total > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
