# Actions de maintenance réservées aux administrateurs, déclenchables depuis l'UI.
module Admin
  class MaintenanceController < ApplicationController
    before_action :require_login!
    before_action :require_full_access!

    # POST /admin/maintenance/backfill_np — recalcule la NP manquante depuis les
    # streams stockés (aucun appel Strava). Renvoie le rapport de comptage.
    def backfill_np
      render json: NormalizedPowerBackfill.call
    end

    # POST /admin/maintenance/backfill_zones — recalcule les histogrammes FC/puissance
    # manquants depuis les streams stockés (aucun appel Strava). Rapport de comptage.
    def backfill_zones
      render json: ZoneHistogramBackfill.call
    end

    private

    # Accès total : rôle Keycloak « Administrator » (roles.json → "all"), ou le
    # booléen admin de compat. On s'appuie sur CanCanCan comme le reste de l'app.
    def require_full_access!
      authorize! :manage, :all
    end
  end
end
