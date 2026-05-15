require "omniauth-oauth2"

module OmniAuth
  module Strategies
    class Strava < OmniAuth::Strategies::OAuth2
      option :name, :strava

      option :client_options,
             site: "https://www.strava.com",
             authorize_url: "https://www.strava.com/oauth/authorize",
             token_url: "https://www.strava.com/oauth/token"

      option :authorize_options, [:scope, :approval_prompt]

      option :scope, "read,activity:read_all"
      option :approval_prompt, "auto"

      uid { raw_info["id"].to_s }

      info do
        {
          name: "#{raw_info['firstname']} #{raw_info['lastname']}".strip,
          first_name: raw_info["firstname"],
          last_name: raw_info["lastname"],
          nickname: raw_info["username"],
          image: raw_info["profile"],
          location: [raw_info["city"], raw_info["country"]].compact.join(", ").presence,
        }
      end

      extra do
        { raw_info: raw_info }
      end

      def raw_info
        @raw_info ||= access_token.params["athlete"] || {}
      end

      def callback_url
        full_host + callback_path
      end
    end
  end
end

OmniAuth.config.add_camelization "strava", "Strava"
