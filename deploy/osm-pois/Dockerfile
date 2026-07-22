# POI auto-hébergés — image du service de synchronisation (remplace overpass-api.de).
#
# Ne contient que l'outillage : les extraits OSM et la base sont dans le volume et
# dans PostgreSQL, jamais dans l'image (voir sync.sh).
#
#   osmium-tool      filtrage des .osm.pbf + export GeoJSON
#   postgresql-client psql / createdb
#   python3          transformation GeoJSON -> CSV (extract.py, stdlib uniquement)

FROM debian:bookworm-slim

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      osmium-tool postgresql-client python3 curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY sync.sh /sync.sh
COPY extract.py /extract.py
RUN chmod +x /sync.sh /extract.py && mkdir -p /data

ENV OSM_POI_SYNC_INTERVAL=604800

CMD ["/bin/bash", "-c", "while true; do /sync.sh; sleep \"$OSM_POI_SYNC_INTERVAL\"; done"]
