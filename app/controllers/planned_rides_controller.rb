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

    # `position` d'abord : l'ordre intra-jour choisi par l'utilisateur pilote l'affichage
    # ET l'appariement « réalisé ». `id` départage les ex æquo (plans jamais réordonnés).
    plans = scope.order(:planned_on, :position, :id).limit(MAX_PLANS)
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

    plan = current_user.planned_rides.create!(route: route, planned_on: date, position: next_position(date))
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

    # Changement de jour = on empile en fin du jour cible (sa place dans l'ancien jour
    # n'a plus de sens). Même jour (simple réordonnancement ailleurs) = position inchangée.
    attrs = { planned_on: date }
    attrs[:position] = next_position(date) if plan.planned_on != date
    plan.update!(attrs)
    render json: { planned_ride: serialize(plan) }
  rescue ActiveRecord::RecordNotUnique
    # Déplacé sur un jour où le même itinéraire est déjà prévu : la cible existe
    # déjà, ce plan-ci fait doublon → on le retire.
    plan.destroy
    head :no_content
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # POST /api/planned_rides/reorder — nouvel ordre intra-jour.
  # Corps : { ordered_ids: [id, id, …] }. On réaffecte position = index. Scopé au
  # propriétaire : un id étranger est simplement ignoré (index_by ne le trouve pas).
  def reorder
    ids = Array(params[:ordered_ids]).map(&:to_i).reject(&:zero?)
    return head :bad_request if ids.empty?

    by_id = current_user.planned_rides.where(id: ids).index_by(&:id)
    PlannedRide.transaction do
      ids.each_with_index { |id, idx| by_id[id]&.update_column(:position, idx) }
    end
    head :no_content
  end

  # DELETE /api/planned_rides/:id
  def destroy
    plan = current_user.planned_rides.find_by(id: params[:id])
    return head :not_found unless plan

    plan.destroy
    head :no_content
  end

  private

  # Prochaine position libre dans un jour (empile en fin). -1 + 1 = 0 pour un jour vide.
  def next_position(date)
    (current_user.planned_rides.where(planned_on: date).maximum(:position) || -1) + 1
  end

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
      position: plan.position,
      # Horodatage de création : le front ne marque un plan « réalisé » que si une
      # activité du jour a eu lieu APRÈS (sinon un plan ajouté après la sortie, ou une
      # intention nouvelle sur un jour déjà couru, passerait à tort pour fait).
      created_at: plan.created_at.iso8601,
      route: {
        id: plan.route.id,
        # Token de partage : sert au lien « naviguer » (/routes/:token/navigate), qui
        # s'ouvre par token et non par id.
        share_token: plan.route.share_token,
        name: plan.route.name,
        activity: plan.route.activity,
        distance_m: plan.route.distance_m,
        elevation_gain_m: plan.route.elevation_gain_m,
        # Colonne brute, comme dans RoutesController#serialize_summary : `null` dit au
        # front « cet itinéraire suit la vitesse du profil », une valeur dit « le
        # créateur l'a ajustée pour ce tracé » — d'où un TSS estimé sur CETTE vitesse,
        # et le repère affiché à côté dans le planificateur.
        avg_speed_kmh: plan.route[:avg_speed_kmh],
      },
    }
  end
end
