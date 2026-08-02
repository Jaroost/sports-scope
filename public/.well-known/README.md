# `.well-known`

## `assetlinks.json` — App Links Android

Déclare que l'application mobile **sports-scope-companion** est autorisée à
ouvrir les URL de ce domaine. Sans ce fichier, Android n'active pas
l'`intent-filter android:autoVerify="true"` de l'appli et un lien
`https://sports.logicraft.ch/routes/<token>/navigate` reste dans le navigateur.

Le fichier doit être servi :

- en **HTTPS**, sans redirection ;
- à la racine exacte `/.well-known/assetlinks.json` ;
- en `application/json`.

### Empreintes déclarées

L'empreinte listée est celle de la **clé de debug** (`~/.android/debug.keystore`,
alias `androiddebugkey`), la seule avec laquelle l'appli est signée aujourd'hui —
`android/app/build.gradle.kts` utilise encore `signingConfigs.getByName("debug")`
pour les builds release.

Le jour où l'appli reçoit une vraie clé de signature, **ajouter** son empreinte
au tableau (ne pas remplacer : garder la clé de debug permet de continuer à
tester sur un build local) :

```bash
keytool -list -v -keystore <clé.jks> -alias <alias> | grep SHA256
```

### Vérifier

Android revalide à l'installation. Pour forcer et diagnostiquer :

```bash
adb shell pm verify-app-links --re-verify com.example.sports_scope_companion
adb shell pm get-app-links com.example.sports_scope_companion
```

`verified` sur le domaine = les liens partagés ouvrent l'appli. Tant que le
fichier n'est pas déployé, le bouton « Naviguer dans l'application » de la page
de partage reste le chemin qui fonctionne : il utilise le schéma propre à
l'appli (`sportsscope://`), qui ne demande aucune vérification.
