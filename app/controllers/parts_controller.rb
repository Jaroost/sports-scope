# Gestion des pièces d'un vélo (usure, et cirage pour la chaîne) : seuil/nom,
# suppression. Toutes les actions sont scopées à l'utilisateur connecté via le
# vélo parent.
class PartsController < ApplicationController
  include BikeSerialization

  before_action :require_login!
  before_action :set_part

  # PATCH /api/parts/:id — renommer / changer le seuil d'usure / éditer les notes /
  # (chaîne uniquement) changer le seuil de cirage ou marquer « à recirer ».
  def update
    @part.name = params[:name].to_s.strip.first(Part::MAX_NAME_LEN) if params[:name].present?
    @part.notes = params[:notes].to_s.strip.first(Part::MAX_NOTES_LEN) if params.key?(:notes)
    @part.wear_threshold_km = params[:wear_threshold_km].to_i if params.key?(:wear_threshold_km)
    if @part.chain_part?
      @part.wax_threshold_km = params[:wax_threshold_km].to_i if params.key?(:wax_threshold_km)
      @part.needs_wax = ActiveModel::Type::Boolean.new.cast(params[:needs_wax]) if params.key?(:needs_wax)
    end
    @part.save!
    render json: { bike: serialize_bike(@part.bike) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # DELETE /api/parts/:id — efface définitivement la pièce (plus d'historique). Voir
  # #discard pour la mettre au rebut en gardant son historique. Refuse d'effacer la
  # dernière chaîne active du vélo (les autres types sont un suivi optionnel,
  # toujours supprimables).
  def destroy
    return render json: { error: "cannot_delete_last" }, status: :unprocessable_entity if last_active_chain?

    bike = @part.bike
    @part.destroy
    render json: { bike: serialize_bike(bike) }
  end

  # POST /api/parts/:id/discard — met la pièce au rebut (usée, cassée…) : son
  # historique reste consultable, mais elle ne peut plus être (re)montée. Referme
  # aussi son montage en cours s'il y en a un. Refuse pour la dernière chaîne
  # active du vélo (même garde que #destroy).
  def discard
    return render json: { error: "cannot_delete_last" }, status: :unprocessable_entity if last_active_chain?

    discarded_at = parse_time(params[:discarded_at]) || Time.current
    return render json: { error: "future_date" }, status: :unprocessable_entity if discarded_at > 1.day.from_now

    @part.part_mounts.where(unmounted_at: nil).update_all(unmounted_at: discarded_at)
    @part.update!(discarded_at: discarded_at)
    render json: { bike: serialize_bike(@part.bike) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # POST /api/parts/:id/restore — annule la mise au rebut (la pièce redevient
  # montable, mais reste démontée : un montage explicite reste nécessaire).
  def restore
    @part.update!(discarded_at: nil)
    render json: { bike: serialize_bike(@part.bike) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # POST /api/parts/:id/wax — marque la chaîne cirée (date par défaut = aujourd'hui,
  # ajustable au passé). `scope: "bike"` cire toutes les chaînes du vélo en même
  # temps. Cirer une chaîne lève le drapeau « à recirer » posé manuellement.
  def wax
    return render json: { error: "not_a_chain" }, status: :unprocessable_entity unless @part.chain_part?

    waxed_at = parse_time(params[:waxed_at]) || Time.current
    return render json: { error: "future_date" }, status: :unprocessable_entity if waxed_at > 1.day.from_now

    chain_type_id = @part.part_type_id
    targets = params[:scope].to_s == "bike" ? @part.bike.parts.where(part_type_id: chain_type_id).to_a : [@part]
    targets.each { |chain| chain.update!(last_waxed_at: waxed_at, needs_wax: false) }
    render json: { bike: serialize_bike(@part.bike) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # POST /api/parts/:id/unmount — referme le montage en cours de la pièce (date par
  # défaut = maintenant, ajustable au passé), sans forcément la remplacer. Sans
  # effet si la pièce n'est pas montée.
  def unmount
    unmounted_at = parse_time(params[:unmounted_at]) || Time.current
    return render json: { error: "future_date" }, status: :unprocessable_entity if unmounted_at > 1.day.from_now

    open_mount = @part.part_mounts.where(unmounted_at: nil).order(:mounted_at).last
    open_mount&.update!(unmounted_at: unmounted_at)
    render json: { bike: serialize_bike(@part.bike) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  private

  # Vrai si @part est une chaîne et la seule chaîne encore active (non mise au
  # rebut) du vélo — la retirer (destroy ou discard) laisserait le vélo sans
  # chaîne montable, ce qu'aucune vue du tableau de bord ne prévoit.
  def last_active_chain?
    return false unless @part.chain_part?

    @part.bike.parts.joins(:part_type)
         .where(part_types: { key: "chain" }, discarded_at: nil).count <= 1
  end

  def set_part
    @part = Part.joins(:bike).where(bikes: { user_id: current_user.id }).find_by(id: params[:id])
    head :not_found unless @part
  end
end
