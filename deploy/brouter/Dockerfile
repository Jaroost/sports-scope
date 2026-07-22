# BRouter auto-hébergé — moteur de routage (remplace l'instance publique brouter.de).
#
# Aucune image officielle n'est publiée : on build depuis les sources, version épinglée.
# Les données (.rd5) et les profils (.brf + lookups.dat) ne sont PAS dans l'image, ils
# sont téléchargés dans les volumes par le service brouter-sync (voir sync.sh).

FROM gradle:jdk17-jammy AS build

ARG BROUTER_VERSION=1.7.10

RUN git clone --depth 1 --branch v${BROUTER_VERSION} \
      https://github.com/abrensch/brouter.git /src

WORKDIR /src
RUN sed -i 's/\r$//' gradlew && ./gradlew --no-daemon clean build -x test

FROM eclipse-temurin:17-jre

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y curl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=build /src/brouter-server/build/libs/brouter-*-all.jar /app/brouter.jar
RUN mkdir -p /segments4 /profiles2 /customprofiles

# Le lanceur fourni par le projet (misc/scripts/standalone/server.sh) est sous-dimensionné
# pour un service partagé : -Xmx128M et 1 seul thread. On appelle RouteServer directement.
# Arguments : <segmentdir> <profiledir> <customprofiledir> <port> <maxthreads>
ENV BROUTER_XMX=1500m \
    BROUTER_THREADS=4

EXPOSE 17777

CMD ["sh", "-c", "exec java -Xmx$BROUTER_XMX -DmaxRunningTime=300 -cp /app/brouter.jar \
     btools.server.RouteServer /segments4 /profiles2 /customprofiles 17777 $BROUTER_THREADS"]
