# Sérialisation JSON partagée d'un vélo + ses chaînes (avec usure calculée), et
# parsing de date tolérant. Utilisé par BikesController et ChainsController.
module BikeSerialization
  extend ActiveSupport::Concern

  private

  def serialize_bike(bike)
    wear = ChainWearService.new(bike)
    {
      id: bike.id,
      name: bike.name,
      is_default: bike.is_default,
      uses_wax: bike.uses_wax,
      strava_gear_id: bike.strava_gear_id,
      mounted_chain_id: wear.mounted_chain_id,
      chains: bike.chains.order(:id).map do |chain|
        {
          id: chain.id,
          name: chain.name,
          wax_threshold_km: chain.wax_threshold_km,
          last_waxed_at: chain.last_waxed_at&.iso8601,
          km_since_wax: wear.km_since_wax(chain),
          progress_percent: wear.progress_percent(chain)
        }
      end
    }
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
