# Sérialisation JSON partagée d'un vélo + ses pièces (avec usure calculée), et
# parsing de date tolérant. Utilisé par BikesController, PartsController.
module BikeSerialization
  extend ActiveSupport::Concern

  private

  def serialize_bike(bike)
    wear = PartWearService.new(bike)
    parts = bike.parts.includes(:part_type).order(:id).to_a

    {
      id: bike.id,
      name: bike.name,
      is_default: bike.is_default,
      uses_wax: bike.uses_wax,
      strava_gear_id: bike.strava_gear_id,
      mounted_chain_id: parts.find { |p| p.chain_part? && wear.mounted?(p) }&.id,
      # Id du PartType « chaîne », pour que ChainWax.vue puisse ajouter une chaîne
      # via POST /api/bikes/:id/parts sans connaître le catalogue des types.
      chain_part_type_id: parts.find(&:chain_part?)&.part_type_id || PartType.find_by(key: "chain")&.id,
      parts: parts.map { |part| serialize_part(part, wear) },
      # Compat : le composant de cirage (ChainWax.vue) ne connaît que les chaînes,
      # actives d'un côté (rotation), au rebut de l'autre (historique replié).
      chains: parts.select { |p| p.chain_part? && !p.discarded? }.map { |part| serialize_part(part, wear) },
      discarded_chains: parts.select { |p| p.chain_part? && p.discarded? }.map { |part| serialize_part(part, wear) }
    }
  end

  def serialize_part(part, wear)
    base = {
      id: part.id,
      name: part.name,
      part_type: {
        id: part.part_type.id,
        key: part.part_type.key,
        name: part.part_type.name,
        icon: part.part_type.icon,
        allow_multiple_mounted: part.part_type.allow_multiple_mounted
      },
      wear_threshold_km: part.wear_threshold_km,
      km_since_mount: wear.km_since_mount(part),
      wear_progress_percent: wear.wear_progress_percent(part),
      mounted: wear.mounted?(part),
      mounted_at: wear.last_mounted_at(part)&.iso8601,
      notes: part.notes,
      discarded_at: part.discarded_at&.iso8601
    }
    return base unless part.chain_part?

    base.merge(
      wax_threshold_km: part.wax_threshold_km,
      last_waxed_at: part.last_waxed_at&.iso8601,
      km_since_wax: wear.km_since_wax(part),
      progress_percent: wear.wax_progress_percent(part),
      needs_wax: part.needs_wax
    )
  end

  # Parse une date/heure fournie par le client (ISO ou `YYYY-MM-DD`). nil si vide
  # ou invalide → l'appelant retombe alors sur `Time.current`.
  def parse_time(value)
    return nil if value.blank?

    Time.zone.parse(value.to_s)
  rescue ArgumentError
    nil
  end
end
