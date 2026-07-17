class PlannedRidesController < ApplicationController
  # Plans de sortie de l'utilisateur : toujours scopés au propriétaire connecté,
  # comme les POI. Aucun partage, aucun accès par token.
  before_action :require_login!

  # Borne le nombre de plans renvoyés : la vue ne montre qu'une semaine, une plage
  # aberrante (from/to sur des années) ne doit pas rapatrier tout l'historique.
  MAX_PLANS = 200

  # GET /api/planned_rides?from=YYYY-MM-DD&to=YYYY-MM-DD
  # Sans plage : tout (l'historique de plans reste petit par nature).
  def index
    scope = current_user.planned_rides.includes(:route)
    scope = scope.where(planned_on: parse_date(params[:from])..) if params[:from].present?
    scope = scope.where(planned_on: ..parse_date(params[:to])) if params[:to].present?

    plans = scope.order(:planned_on).limit(MAX_PLANS)
    render json: { planned_rides: plans.map { |p| serialize(p) } }
  end

  # POST /api/planned_rides
  def create
    # `current_user.routes` et pas `Route` : sans ce scope on planifierait
    # l'itinéraire de quelqu'un d'autre à partir d'un id deviné.
    route = current_user.routes.find_by(id: params[:route_id])
    return head :not_found unless route

    date = parse_date(params[:planned_on])
    return render json: { error: "planned_on invalide" }, status: :unprocessable_entity unless date

    plan = current_user.planned_rides.create!(route: route, planned_on: date)
    render json: { planned_ride: serialize(plan) }, status: :created
  rescue ActiveRecord::RecordNotUnique
    # Déjà prévu ce jour-là (index unique) : l'état voulu est atteint, on renvoie
    # l'existant plutôt qu'une erreur — un double clic n'est pas un échec.
    existing = current_user.planned_rides.find_by(route_id: route.id, planned_on: date)
    render json: { planned_ride: serialize(existing) }, status: :ok
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # PATCH /api/planned_rides/:id — déplacer un plan sur un autre jour.
  def update
    plan = current_user.planned_rides.find_by(id: params[:id])
    return head :not_found unless plan

    date = parse_date(params[:planned_on])
    return render json: { error: "planned_on invalide" }, status: :unprocessable_entity unless date

    plan.update!(planned_on: date)
    render json: { planned_ride: serialize(plan) }
  rescue ActiveRecord::RecordNotUnique
    # Déplacé sur un jour où le même itinéraire est déjà prévu : la cible existe
    # déjà, ce plan-ci fait doublon → on le retire.
    plan.destroy
    head :no_content
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # DELETE /api/planned_rides/:id
  def destroy
    plan = current_user.planned_rides.find_by(id: params[:id])
    return head :not_found unless plan

    plan.destroy
    head :no_content
  end

  private

  def parse_date(raw)
    Date.parse(raw.to_s)
  rescue ArgumentError, TypeError
    nil
  end

  # Dimensions de l'itinéraire, pas son TSS : c'est le front qui l'estime, avec les
  # seuils du moment (cf. le commentaire d'en-tête de PlannedRide).
  def serialize(plan)
    {
      id: plan.id,
      planned_on: plan.planned_on.iso8601,
      route: {
        id: plan.route.id,
        name: plan.route.name,
        activity: plan.route.activity,
        distance_m: plan.route.distance_m,
        elevation_gain_m: plan.route.elevation_gain_m,
      },
    }
  end
end
