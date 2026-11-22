# Profils BRouter maison (overlay)

Tout fichier `.brf` déposé ici est copié par `sync.sh` **par-dessus** le miroir de
`brouter.de/brouter/profiles2/`, à chaque synchronisation. Il gagne donc sur la
version amont du même nom.

Deux usages :

- **figer** un profil amont (le miroir ne l'écrasera plus) ;
- **ajouter** un profil qui n'existe pas chez brouter.de.

Le nom du fichier est le nom du profil : `mon-profil.brf` → `&profile=mon-profil`.
Un nouveau profil doit aussi être déclaré côté app, sinon il sera rejeté avant même
d'atteindre BRouter :

- `app/javascript/brouter.ts` → `PROFILES_BY_SPORT`
- `app/controllers/routes_controller.rb` → `ALLOWED_PROFILES`

Après ajout : `docker compose run --rm brouter-sync bash /sync.sh`

`custom-cycling`, `custom-mtb` et `custom-hiking` sont les profils « atelier » du site (réglables
variable par variable, cf. CLAUDE.md § Profils de routage personnalisés) : leurs variables doivent
rester déclarées dans `---context:global`, sinon le moteur refuse de les surcharger.

Le dossier peut rester vide (ce fichier suffit à le versionner).
