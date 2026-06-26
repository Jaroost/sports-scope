class PoisController < ApplicationController
  # POI globaux à l'utilisateur (pas liés à un itinéraire) : toujours scopés au
  # propriétaire connecté.
  before_action :require_login!

  # GET /api/pois
  def index
    pois = current_user.pois.order(created_at: :desc)
    render json: { pois: pois.map { |p| serialize(p) } }
  end

  # POST /api/pois
  def create
    poi = current_user.pois.create!(sanitize_attrs(params))
    render json: { poi: serialize(poi) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # PATCH /api/pois/:id
  def update
    poi = current_user.pois.find_by(id: params[:id])
    return head :not_found unless poi
    poi.update!(sanitize_attrs(params).compact)
    render json: { poi: serialize(poi) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # DELETE /api/pois/:id
  def destroy
    poi = current_user.pois.find_by(id: params[:id])
    return head :not_found unless poi
    poi.destroy
    head :no_content
  end

  private

  # Ne retient que les clés réellement présentes dans le payload pour que les PATCH
  # partiels (rename seul, déplacement seul…) n'écrasent pas le reste.
  def sanitize_attrs(p)
    out = {}
    out[:name] = p[:name].to_s.strip.first(Poi::MAX_NAME_LEN).presence if p.key?(:name)
    out[:category] = p[:category] if p.key?(:category)
    out[:source] = Poi::SOURCES.include?(p[:source].to_s) ? p[:source] : "custom" if p.key?(:source)
    out[:lat] = clean_coord(p[:lat], 90) if p.key?(:lat)
    out[:lng] = clean_coord(p[:lng], 180) if p.key?(:lng)
    out
  end

  # Coordonnée numérique dans la plage [-limit, limit], sinon nil (rejeté par la
  # validation de présence du modèle).
  def clean_coord(raw, limit)
    v = Float(raw, exception: false)
    return nil if v.nil? || v.abs > limit
    v
  end

  def serialize(poi)
    {
      id: poi.id,
      name: poi.name,
      category: poi.category,
      lat: poi.lat,
      lng: poi.lng,
      source: poi.source,
    }
  end
end
