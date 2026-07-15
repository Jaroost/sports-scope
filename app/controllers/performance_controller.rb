# Analyse de performance : records absolus, cumuls, meilleures périodes et courbe
# puissance-max/temps agrégés sur toutes les activités de l'utilisateur.
# Consommé en JSON par le composant `PerformanceAnalysis.vue`.
class PerformanceController < ApplicationController
  before_action :require_login!

  # GET /api/performance
  def show
    render json: PerformanceRecords.for_user(current_user, performance_filters)
  end

  # GET /api/performance/ftp — FTP estimée (auto/manuelle), W/kg et historique (vélo).
  def ftp
    render json: FtpEstimator.summary(current_user)
  end

  # GET /api/performance/training_load — courbe forme/fatigue (CTL/ATL/TSB) tous sports.
  def training_load
    render json: TrainingLoad.summary(current_user)
  end

  private

  # Mêmes filtres que la liste du tableau de bord (cf. StravaController) : sport
  # (type brut), distance/dénivelé/durée min-max et plage de dates. Transmis bruts
  # à `PerformanceRecords` qui les normalise (unités, dates) et les applique aux
  # activités agrégées.
  def performance_filters
    params.permit(:sport, :min_dist, :max_dist, :min_elev, :max_elev,
                  :min_dur, :max_dur, :from, :to).to_h.symbolize_keys
  end
end
