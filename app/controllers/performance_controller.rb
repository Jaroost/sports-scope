# Analyse de performance : records absolus, cumuls, meilleures périodes et courbe
# puissance-max/temps agrégés sur toutes les activités de l'utilisateur.
# Consommé en JSON par le composant `PerformanceAnalysis.vue`.
class PerformanceController < ApplicationController
  before_action :require_login!

  # GET /api/performance
  def show
    render json: PerformanceRecords.for_user(current_user)
  end

  # GET /api/performance/ftp — FTP estimée (auto/manuelle), W/kg et historique (vélo).
  def ftp
    render json: FtpEstimator.summary(current_user)
  end

  # GET /api/performance/training_load — courbe forme/fatigue (CTL/ATL/TSB) tous sports.
  def training_load
    render json: TrainingLoad.summary(current_user)
  end
end
