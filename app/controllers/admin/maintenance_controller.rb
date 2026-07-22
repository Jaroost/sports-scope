# Actions de maintenance réservées aux administrateurs, déclenchables depuis l'UI.
module Admin
  class MaintenanceController < ApplicationController
    before_action :require_login!
    before_action :require_full_access!

    # POST /admin/maintenance/backfill_derivations — recalcule toutes les métriques
    # dérivées manquantes/obsolètes (NP, courbe de puissance, histogrammes FC/puissance…)
    # depuis les streams déjà stockés, sans aucun appel Strava. Renvoie le rapport.
    def backfill_derivations
      render json: ActivityDerivationsBackfill.call
    end

    private

    # Accès total : rôle Keycloak « Administrator » (roles.json → "all"), ou le
    # booléen admin de compat. On s'appuie sur CanCanCan comme le reste de l'app.
    def require_full_access!
      authorize! :manage, :all
    end
  end
end
