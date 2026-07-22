# Noms donnés aux segments découverts automatiquement (`SegmentMatcher`).
#
# Un segment n'ayant pas d'existence en base, on le baptise en enregistrant son
# CHEMIN : le client envoie la plage d'indices de streams du segment tel qu'il le
# voit sur l'activité affichée, et le serveur en découpe la suite de cellules
# (`TrackFingerprint.slice`). Le nom est ensuite retrouvé depuis n'importe quelle
# autre sortie passant par là.
class NamedSegmentsController < ApplicationController
  before_action :require_login!

  # POST /api/named_segments
  # Params : source ('strava' | 'imported'), activity_id, start_idx, end_idx, name.
  def create
    activity = find_activity
    return head :not_found unless activity

    slice = TrackFingerprint.slice(activity.track_cells, params[:start_idx].to_i, params[:end_idx].to_i)
    return render json: { error: 'segment introuvable' }, status: :unprocessable_entity unless slice

    # Le même chemin peut déjà porter un nom posé depuis une autre sortie (le front
    # ne le sait pas toujours : bornes légèrement différentes). On renomme alors
    # l'existant plutôt que d'empiler deux noms sur le même terrain.
    existing = matching_segment(slice[:cells], slice[:coarse])
    if existing
      existing.update!(name: clean_name)
      return render json: { named_segment: serialize(existing) }
    end

    segment = current_user.named_segments.create!(slice.merge(name: clean_name))
    render json: { named_segment: serialize(segment) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # PATCH /api/named_segments/:id — renommer.
  def update
    segment = current_user.named_segments.find_by(id: params[:id])
    return head :not_found unless segment

    segment.update!(name: clean_name)
    render json: { named_segment: serialize(segment) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # DELETE /api/named_segments/:id — le segment reste détecté, il redevient anonyme.
  def destroy
    segment = current_user.named_segments.find_by(id: params[:id])
    return head :not_found unless segment

    segment.destroy
    head :no_content
  end

  private

  # Segment nommé couvrant déjà ce chemin, s'il y en a un (même rapprochement que
  # `SegmentMatcher#naming`).
  def matching_segment(cells, coarse)
    current_user.named_segments.in_coarse(coarse)
                .select { |ns| ns.overlap_with(cells) >= NamedSegment::MATCH_RATIO }
                .max_by { |ns| ns.overlap_with(cells) }
  end

  def find_activity
    if params[:source].to_s == 'imported'
      current_user.imported_activities.find_by(id: params[:activity_id])
    else
      current_user.strava_activities.find_by(strava_id: params[:activity_id])
    end
  end

  def clean_name
    params[:name].to_s.strip.first(NamedSegment::MAX_NAME_LEN)
  end

  def serialize(segment)
    { id: segment.id, name: segment.name, distance_m: segment.distance_m }
  end
end
