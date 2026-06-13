class GeocodesController < ApplicationController
  before_action :require_login!

  def places
    south = params.require(:south).to_f
    west  = params.require(:west).to_f
    north = params.require(:north).to_f
    east  = params.require(:east).to_f

    query = <<~OVERPASS
      [out:json][timeout:25];
      node["place"~"^(city|town|village|hamlet)$"](#{south},#{west},#{north},#{east});
      out body;
    OVERPASS

    uri = URI("https://overpass-api.de/api/interpreter")
    response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 5, read_timeout: 30) do |http|
      req = Net::HTTP::Post.new(uri)
      req["User-Agent"] = "SportsScope/1.0 (#{request.host})"
      req.set_form_data("data" => query)
      http.request(req)
    end

    data = JSON.parse(response.body)
    places = data["elements"].filter_map do |el|
      name = el.dig("tags", "name")
      next unless name
      { lat: el["lat"], lng: el["lon"], name: name, type: el.dig("tags", "place") }
    end

    render json: places
  rescue Net::OpenTimeout, Net::ReadTimeout
    render json: { error: "timeout" }, status: :gateway_timeout
  rescue => e
    render json: { error: e.message }, status: :bad_gateway
  end
end
