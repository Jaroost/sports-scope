// Échappement HTML, partagé par tout ce qui compose du balisage à la main (tooltips de
// carte, infobulles de graphique). Les cinq caractères sensibles sont couverts, ce qui rend
// la sortie sûre en contenu d'élément COMME en valeur d'attribut — contrairement à un
// aller-retour par `textContent`, qui laisse passer les guillemets.
export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]
  ))
}
