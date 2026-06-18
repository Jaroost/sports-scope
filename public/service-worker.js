// Service worker minimal de Sports Scope.
//
// Objectif actuel : satisfaire les critères d'installabilité PWA (Android /
// Play Store via TWA) — PAS encore de cache hors-ligne. Il se contente de
// laisser passer les requêtes vers le réseau. Quand on voudra l'offline, on
// ajoutera une stratégie de cache dans le handler `fetch`.

const VERSION = 'v1'

self.addEventListener('install', () => {
  // Active immédiatement la nouvelle version sans attendre la fermeture des onglets.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Prend le contrôle des pages déjà ouvertes dès l'activation.
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', () => {
  // Présence d'un handler `fetch` requise pour l'installabilité.
  // On ne fait rien de spécial : le navigateur gère la requête normalement.
})
