# Amis : demandes, liste, fil, et lecture seule des sorties / itinéraires qu'un ami
# m'a ouverts. La règle « qui voit quoi » vit dans FriendVisibility — ici on ne
# filtre jamais à la main.
#
# Convention d'identifiants : `update` / `destroy` prennent l'id de la `Friendship` ;
# toutes les autres actions prennent l'id de l'**utilisateur** ami (`:id`).
class FriendsController < ApplicationController
  before_action :require_login!

  FEED_LIMIT = 40
  # Colonnes légères du fil : jamais `streams` / `raw` / `track_cells`.
  FEED_COLUMNS = %i[id user_id name activity_type started_at distance_m moving_time_s total_elevation_gain].freeze

  # GET /api/friends
  def index
    # `has_secure_token` ne remplit qu'à la création : les comptes existants n'en ont pas.
    current_user.regenerate_friend_invite_token if current_user.friend_invite_token.blank?
    friendships = Friendship.involving(current_user).includes(:requester, :addressee).order(:created_at)
    accepted, pending = friendships.partition(&:accepted?)
    render json: {
      friends: accepted.map { |f| friend_json(f) },
      incoming: pending.select { |f| f.addressee_id == current_user.id }.map { |f| friend_json(f) },
      outgoing: pending.select { |f| f.requester_id == current_user.id }.map { |f| friend_json(f) },
      invite_url: friend_invite_url(token: current_user.friend_invite_token),
    }
  end

  # POST /api/friends { email }
  # Réponse toujours neutre : on ne révèle pas si une adresse correspond à un compte.
  def create
    target = User.find_by(email: params[:email].to_s.strip.downcase)
    request_friendship(target) if target
    render json: { ok: true }, status: :accepted
  end

  # GET /friends/invite/:token — l'invitant n'a pas validé d'avance : le lien crée une
  # *demande* qu'il doit accepter (un lien qui circule ne donne pas accès à ses sorties).
  def invite
    inviter = User.find_by(friend_invite_token: params[:token].to_s)
    request_friendship(inviter) if inviter
    redirect_to friends_path, notice: t("friends.invite_sent")
  end

  # PATCH /api/friends/:id — le destinataire accepte.
  def update
    friendship = Friendship.pending.find_by(id: params[:id], addressee_id: current_user.id)
    return head :not_found unless friendship

    friendship.accept!
    render json: { friend: friend_json(friendship) }
  end

  # DELETE /api/friends/:id — refuse, annule ou rompt (les deux côtés).
  def destroy
    friendship = Friendship.involving(current_user).find_by(id: params[:id])
    return head :not_found unless friendship

    friendship.destroy!
    head :no_content
  end

  # GET /api/friends/feed
  def feed
    items = []
    current_user.friends.find_each do |friend|
      FriendVisibility::SOURCES.each do |source, model|
        FriendVisibility.activities(model, friend, current_user)
                        .order(started_at: :desc).limit(FEED_LIMIT).select(*FEED_COLUMNS).each do |a|
          items << feed_activity(a, source, friend)
        end
      end
      FriendVisibility.routes(friend, current_user).order(updated_at: :desc).limit(FEED_LIMIT).each do |r|
        items << { kind: "route", id: r.id, friend_id: friend.id, friend_name: friend.display_name,
                   name: r.name, date: r.updated_at.iso8601, distance_m: r.distance_m,
                   elevation_gain_m: r.elevation_gain_m, share_token: r.share_token,
                   preview_segments: r.preview_segments }
      end
    end
    render json: { items: items.sort_by { |i| i[:date].to_s }.reverse.first(FEED_LIMIT) }
  end

  # GET /api/friends/:id/routes/:route_id
  def route
    owner = current_user.friends.find_by(id: params[:id])
    route = owner && FriendVisibility.routes(owner, current_user).find_by(id: params[:route_id])
    return head :not_found unless route

    render json: { route: { id: route.id, name: route.name, distance_m: route.distance_m,
                            elevation_gain_m: route.elevation_gain_m, share_token: route.share_token,
                            preview_segments: route.preview_segments, map_polyline: route.map_polyline } }
  end

  # GET /api/friends/:id/activities/:source/:activity_id
  def activity
    record = visible_activity
    return head :not_found unless record

    render json: { activity: activity_json(record, params[:source]) }
  end

  # GET /api/friends/:id/activities/:source/:activity_id/streams
  def activity_streams
    record = visible_activity
    return head :not_found unless record

    streams = record.effective_streams
    render json: { streams: streams.is_a?(Hash) ? streams : {}, stream_exclusions: record.stream_exclusions,
                   ignored_streams: record.ignored_streams }
  end

  # PATCH /api/activities/:source/:id/friend_visibility { visibility: shared|private|default }
  def activity_visibility
    # Côté propriétaire, la page d'une sortie Strava est adressée par `strava_id`
    # (comme `StravaController`) ; une sortie importée par son id local.
    model = FriendVisibility::SOURCES[params[:source]]
    key = params[:source] == "strava" ? :strava_id : :id
    record = model.find_by(key => params[:id], user_id: current_user.id)
    return head :not_found unless record

    value = { "shared" => true, "private" => false, "default" => nil }.fetch(params[:visibility].to_s) do
      return render json: { error: "invalid visibility" }, status: :unprocessable_entity
    end
    # update_column : ni `updated_at` ni callbacks — un simple réglage de partage ne doit
    # pas invalider `UserActivities.data_version` (caches FTP / records / charge).
    record.update_column(:friends_visible, value)
    render json: { friends_visible: value }
  end

  # GET /api/routes/:id/shares
  def route_shares
    route = current_user.routes.find_by(id: params[:id])
    return head :not_found unless route

    shared_ids = route.route_shares.pluck(:user_id)
    render json: { friends: current_user.friends.map { |u| { user_id: u.id, display_name: u.display_name, shared: shared_ids.include?(u.id) } } }
  end

  # POST /api/routes/:id/shares { user_id }
  def share_route
    route = current_user.routes.find_by(id: params[:id])
    friend = current_user.friends.find_by(id: params[:user_id])
    return head :not_found unless route && friend

    RouteShare.find_or_create_by!(route: route, user: friend)
    head :no_content
  end

  # DELETE /api/routes/:id/shares/:user_id
  def unshare_route
    route = current_user.routes.find_by(id: params[:id])
    return head :not_found unless route

    route.route_shares.where(user_id: params[:user_id]).destroy_all
    head :no_content
  end

  private

  def request_friendship(other)
    return if other.id == current_user.id

    existing = Friendship.between(current_user, other)
    if existing
      # L'autre m'avait déjà invité : ma demande vaut acceptation.
      existing.accept! if existing.pending? && existing.addressee_id == current_user.id
    else
      Friendship.create!(requester: current_user, addressee: other)
    end
  end

  def visible_activity
    owner = current_user.friends.find_by(id: params[:id])
    owner && FriendVisibility.activity(params[:source], owner, current_user, params[:activity_id])
  end

  # Seul `display_name` est exposé : jamais l'e-mail d'autrui.
  def friend_json(friendship)
    other = friendship.other_user(current_user)
    { id: friendship.id, user_id: other.id, display_name: other.display_name,
      since: friendship.accepted_at&.iso8601 }
  end

  def feed_activity(record, source, friend)
    { kind: "activity", source: source, id: record.id, friend_id: friend.id, friend_name: friend.display_name,
      name: record.name, type: record.activity_type, date: record.started_at&.iso8601,
      distance_m: record.distance_m, moving_time_s: record.moving_time_s,
      elevation_gain_m: record.total_elevation_gain }
  end

  # Résumé construit depuis les colonnes seules (jamais `raw` : il porte des champs du
  # compte Strava de l'ami). Mêmes clés que `StravaController#built_summary`, pour que
  # le détail d'activité s'affiche sans cas particulier ; `id` est l'id local.
  def activity_json(a, source)
    {
      "id" => a.id, "source" => source, "name" => a.name,
      "type" => a.activity_type, "sport_type" => a.activity_type,
      "start_date" => a.started_at&.iso8601, "start_date_local" => a.started_at&.iso8601,
      "distance" => a.distance_m, "moving_time" => a.moving_time_s, "elapsed_time" => a.elapsed_time_s,
      "total_elevation_gain" => a.total_elevation_gain,
      "average_speed" => a.average_speed, "max_speed" => a.max_speed,
      "average_heartrate" => a.average_heartrate, "max_heartrate" => a.max_heartrate,
      "average_watts" => a.average_watts, "max_watts" => a.max_watts,
      "average_cadence" => a.average_cadence,
      "normalized_power" => a.normalized_power,
      "start_latlng" => a.start_latlng, "end_latlng" => a.end_latlng,
      "new_ranges" => a.new_ranges, "laps" => (a.laps if a.respond_to?(:laps)),
    }.compact
  end
end
