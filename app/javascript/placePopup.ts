import { t } from './i18n'
import { escapeHtml } from './html'

export { escapeHtml }

// Briques communes des tooltips de carte (« popups de lieu »).
//
// Toutes les cartes de l'app ouvrent le même genre de tooltip — un titre, une croix de
// fermeture, puis une pile d'actions et de liens externes — dans le créateur d'itinéraire,
// la navigation et la tooltip « point quelconque ». Le balisage était recopié à chaque fois,
// avec des écarts qui n'avaient aucune raison d'être : libellé de fermeture parfois en dur
// (« Fermer ») au lieu de la traduction, titre tantôt échappé tantôt non, quatre copies de
// `escapeHtml`. Les classes CSS (`.place-popup*`) sont globales et partagées par les
// composants : c'est le contrat de rendu de ces briques.

/** Lien Google Maps centré sur un point (fiche du lieu, pas un itinéraire). */
export function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`
}

// En-tête : le nom du lieu et la croix de fermeture. Le titre est échappé ici — l'appelant
// passe du texte, jamais du balisage.
export function popupHeaderHtml(title: string): string {
  return `
    <div class="place-popup-header">
      <span class="place-popup-name">${escapeHtml(title)}</span>
      <button type="button" class="place-popup-close" aria-label="${escapeHtml(t('routes.close'))}">×</button>
    </div>`
}

export interface PopupLink {
  href: string
  /** Classes FontAwesome de l'icône (ex. « fa-solid fa-street-view »). */
  icon: string
  label: string
  /** Classe supplémentaire, pour cibler le lien ensuite (ex. « place-popup-link--streetview »). */
  className?: string
}

/** Lien externe d'une tooltip : ouvre un nouvel onglet, sans fuite de référent. */
export function popupLinkHtml({ href, icon, label, className }: PopupLink): string {
  const extra = className ? ` ${className}` : ''
  return `
    <a class="place-popup-link${extra}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
      <i class="${icon}" aria-hidden="true"></i>
      <span>${escapeHtml(label)}</span>
    </a>`
}

export interface PopupAction {
  /** Classe de ciblage du bouton (ex. « place-popup-link--add-route »). */
  className: string
  icon: string
  label: string
}

/** Bouton d'action d'une tooltip (ajouter au tracé, sauvegarder, supprimer…). */
export function popupActionHtml({ className, icon, label }: PopupAction): string {
  return `
    <button type="button" class="place-popup-link ${className}">
      <i class="${icon}" aria-hidden="true"></i>
      <span>${escapeHtml(label)}</span>
    </button>`
}

// Les deux liens externes que TOUTE tooltip de lieu propose : la fiche Google Maps et le
// panorama Street View. Les URL sont passées telles quelles — les appelants les composent
// différemment (décalage de la fiche pour ne pas masquer un POI, orientation de la caméra
// Street View selon le tracé). Le lien Street View porte sa classe de ciblage, car il est
// grisé après coup selon la disponibilité (cf. probeStreetViewLink).
export function popupMapLinksHtml(mapsUrl: string, svUrl: string): string {
  return (
    popupLinkHtml({ href: mapsUrl, icon: 'fa-brands fa-google', label: 'Google Maps' }) +
    popupLinkHtml({
      href: svUrl,
      icon: 'fa-solid fa-street-view',
      label: t('routes.street_view'),
      className: 'place-popup-link--streetview',
    })
  )
}

// Ligne « Lat / Lng » copiables. Le clic est câblé par l'appelant (cf. `.place-popup-link--copy`
// et l'attribut `data-coord`), qui gère l'accusé de copie.
export function popupCoordsRowHtml(lat: number, lng: number): string {
  const cell = (value: string, label: string, title: string) => `
      <button type="button" class="place-popup-link place-popup-link--copy" data-coord="${value}" title="${escapeHtml(title)}">
        <i class="fa-regular fa-copy" aria-hidden="true"></i>
        <span>${label}&nbsp;${value}</span>
      </button>`
  return `
    <div class="place-popup-coords-row">
      ${cell(lat.toFixed(6), 'Lat', t('routes.copy_latitude'))}
      ${cell(lng.toFixed(6), 'Lng', t('routes.copy_longitude'))}
    </div>`
}
