// Bouton « copier l'adresse » de la page de partage d'un itinéraire
// (app/views/pages/route_summary.html.erb) : contenu server-rendu, sans îlot Vue, d'où
// ce petit module vanilla plutôt qu'un composant. Reprend le même geste (icône qui se
// change en coche verte 1,2 s) que les boutons de copie du créateur (cf.
// RouteBuilderMap.vue / mapCoordPopup.ts), avec le même repli textarea pour les
// contextes sans Clipboard API (HTTP non sécurisé, vieux navigateur).
export function installAddressCopyButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.route-summary-copy-address').forEach((btn) => {
    btn.addEventListener('click', () => copyAddress(btn))
  })
}

async function copyAddress(btn: HTMLButtonElement): Promise<void> {
  const text = btn.dataset.address || ''
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    document.body.removeChild(ta)
  }
  const icon = btn.querySelector('i')
  if (!icon) return
  icon.classList.replace('fa-regular', 'fa-solid')
  icon.classList.replace('fa-copy', 'fa-check')
  icon.classList.add('text-success')
  setTimeout(() => {
    icon.classList.replace('fa-check', 'fa-copy')
    icon.classList.replace('fa-solid', 'fa-regular')
    icon.classList.remove('text-success')
  }, 1200)
}
