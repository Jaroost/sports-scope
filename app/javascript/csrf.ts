// Jeton CSRF de la page, posé par Rails dans <meta name="csrf-token">.
//
// À joindre en en-tête `X-CSRF-Token` de tout appel d'écriture (POST/PATCH/DELETE) vers
// l'app, sans quoi Rails rejette la requête. Chaîne vide si la balise est absente (page
// servie hors Rails, test) : l'appel partira et sera refusé côté serveur, ce qui est le
// comportement voulu — mieux vaut une erreur explicite qu'un jeton inventé.
export function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}
