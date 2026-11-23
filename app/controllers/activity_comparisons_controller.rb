# Comparaison de deux sorties de l'utilisateur (cf. ActivityComparison).
#   GET /compare?a=strava:1&b=imported:2          la page (îlot Vue)
#   GET /api/activity_comparison?a=…&b=…[&stretch=n]  les données superposées (n : tronçon commun, 0 = le plus long)
#   GET /api/activity_comparison/similar?ref=…     sorties qui ressemblent à `ref`
class ActivityComparisonsController < ApplicationController
  before_action :require_login!

  def show
    @a = ActivityComparison.parse_ref(params[:a])
    @b = ActivityComparison.parse_ref(params[:b])
    render :show
  end

  def data
    a = load(params[:a])
    b = load(params[:b])
    return head :not_found unless a && b
    return head :unprocessable_entity if a == b

    render json: ActivityComparison.call(current_user, a, b, stretch: params[:stretch])
  end

  def similar
    activity = load(params[:ref])
    return head :not_found unless activity

    render json: { activities: ActivityComparison.similar(current_user, activity) }
  end

  private

  def load(value)
    ref = ActivityComparison.parse_ref(value)
    ref && ActivityComparison.find_activity(current_user, ref)
  rescue ActivityComparison::NotFound
    nil
  end
end
