# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_07_11_000004) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

  create_table "bikes", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.boolean "is_default", default: false, null: false
    t.string "name", null: false
    t.string "strava_gear_id"
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.boolean "uses_wax", default: true, null: false
    t.index ["user_id", "strava_gear_id"], name: "index_bikes_on_user_id_and_strava_gear_id", unique: true
    t.index ["user_id"], name: "index_bikes_on_user_id"
  end

  create_table "chain_mounts", force: :cascade do |t|
    t.bigint "bike_id", null: false
    t.bigint "chain_id", null: false
    t.datetime "created_at", null: false
    t.datetime "mounted_at", null: false
    t.datetime "updated_at", null: false
    t.index ["bike_id", "mounted_at"], name: "index_chain_mounts_on_bike_id_and_mounted_at"
    t.index ["bike_id"], name: "index_chain_mounts_on_bike_id"
    t.index ["chain_id"], name: "index_chain_mounts_on_chain_id"
  end

  create_table "chains", force: :cascade do |t|
    t.bigint "bike_id", null: false
    t.datetime "created_at", null: false
    t.datetime "last_waxed_at"
    t.string "name", null: false
    t.boolean "needs_wax", default: false, null: false
    t.datetime "updated_at", null: false
    t.integer "wax_threshold_km", default: 300, null: false
    t.index ["bike_id"], name: "index_chains_on_bike_id"
  end

  create_table "chart_layouts", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.jsonb "layout", default: [], null: false
    t.string "name", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.index ["user_id", "name"], name: "index_chart_layouts_on_user_id_and_name", unique: true
    t.index ["user_id"], name: "index_chart_layouts_on_user_id"
  end

  create_table "imported_activities", force: :cascade do |t|
    t.string "activity_type"
    t.float "average_cadence"
    t.float "average_heartrate"
    t.float "average_speed"
    t.float "average_temp"
    t.float "average_watts"
    t.datetime "created_at", null: false
    t.float "distance_m"
    t.integer "elapsed_time_s"
    t.jsonb "end_latlng"
    t.string "filename"
    t.float "max_cadence"
    t.float "max_heartrate"
    t.float "max_speed"
    t.float "max_watts"
    t.integer "moving_time_s"
    t.string "name", null: false
    t.jsonb "peak_powers", default: {}, null: false
    t.string "source", default: "fit", null: false
    t.jsonb "start_latlng"
    t.datetime "started_at"
    t.jsonb "streams", default: {}, null: false
    t.float "total_elevation_gain"
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.index ["user_id", "started_at"], name: "index_imported_activities_on_user_id_and_started_at"
    t.index ["user_id"], name: "index_imported_activities_on_user_id"
  end

  create_table "opened_routes", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "last_opened_at", null: false
    t.bigint "route_id", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.index ["route_id"], name: "index_opened_routes_on_route_id"
    t.index ["user_id", "last_opened_at"], name: "index_opened_routes_on_user_id_and_last_opened_at"
    t.index ["user_id", "route_id"], name: "index_opened_routes_on_user_id_and_route_id", unique: true
    t.index ["user_id"], name: "index_opened_routes_on_user_id"
  end

  create_table "pois", force: :cascade do |t|
    t.string "category", null: false
    t.datetime "created_at", null: false
    t.float "lat", null: false
    t.float "lng", null: false
    t.string "name", null: false
    t.string "source", default: "custom", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.index ["user_id"], name: "index_pois_on_user_id"
  end

  create_table "routes", force: :cascade do |t|
    t.string "activity", default: "cycling", null: false
    t.datetime "created_at", null: false
    t.float "distance_m"
    t.float "elevation_gain_m"
    t.float "elevation_loss_m"
    t.jsonb "geometry", default: [], null: false
    t.jsonb "map_polyline"
    t.string "name", null: false
    t.jsonb "pois", default: [], null: false
    t.jsonb "preview_segments"
    t.string "profile", default: "trekking"
    t.string "share_token", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.jsonb "voice_hints", default: [], null: false
    t.jsonb "waypoints", default: [], null: false
    t.index ["share_token"], name: "index_routes_on_share_token", unique: true
    t.index ["user_id", "updated_at"], name: "index_routes_on_user_id_and_updated_at"
    t.index ["user_id"], name: "index_routes_on_user_id"
  end

  create_table "strava_activities", force: :cascade do |t|
    t.string "activity_type"
    t.float "average_cadence"
    t.float "average_heartrate"
    t.float "average_speed"
    t.float "average_temp"
    t.float "average_watts"
    t.datetime "created_at", null: false
    t.float "distance_m"
    t.integer "elapsed_time_s"
    t.jsonb "end_latlng"
    t.string "gear_id"
    t.float "max_cadence"
    t.float "max_heartrate"
    t.float "max_speed"
    t.float "max_watts"
    t.integer "moving_time_s"
    t.string "name", null: false
    t.jsonb "peak_powers", default: {}, null: false
    t.jsonb "raw", default: {}, null: false
    t.jsonb "start_latlng"
    t.datetime "started_at"
    t.bigint "strava_id", null: false
    t.jsonb "streams", default: {}, null: false
    t.float "total_elevation_gain"
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.index ["user_id", "gear_id"], name: "index_strava_activities_on_user_id_and_gear_id"
    t.index ["user_id", "started_at"], name: "index_strava_activities_on_user_id_and_started_at"
    t.index ["user_id", "strava_id"], name: "index_strava_activities_on_user_id_and_strava_id", unique: true
    t.index ["user_id"], name: "index_strava_activities_on_user_id"
  end

  create_table "strava_activity_peak_powers", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.jsonb "peak_powers", default: {}, null: false
    t.datetime "started_at"
    t.string "strava_activity_id", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.index ["user_id", "strava_activity_id"], name: "idx_strava_peak_powers_user_activity", unique: true
    t.index ["user_id"], name: "index_strava_activity_peak_powers_on_user_id"
  end

  create_table "users", force: :cascade do |t|
    t.boolean "admin", default: false, null: false
    t.jsonb "chart_layout"
    t.datetime "created_at", null: false
    t.string "display_name"
    t.string "email", null: false
    t.string "keycloak_uid", null: false
    t.bigint "last_chart_layout_id"
    t.jsonb "preferences", default: {}, null: false
    t.jsonb "roles", default: [], null: false
    t.string "strava_access_token"
    t.datetime "strava_expires_at"
    t.string "strava_refresh_token"
    t.string "strava_uid"
    t.datetime "updated_at", null: false
    t.index ["email"], name: "index_users_on_email", unique: true
    t.index ["keycloak_uid"], name: "index_users_on_keycloak_uid", unique: true
    t.index ["last_chart_layout_id"], name: "index_users_on_last_chart_layout_id"
    t.index ["strava_uid"], name: "index_users_on_strava_uid", unique: true, where: "(strava_uid IS NOT NULL)"
  end

  add_foreign_key "bikes", "users"
  add_foreign_key "chain_mounts", "bikes"
  add_foreign_key "chain_mounts", "chains"
  add_foreign_key "chains", "bikes"
  add_foreign_key "chart_layouts", "users"
  add_foreign_key "imported_activities", "users"
  add_foreign_key "opened_routes", "routes"
  add_foreign_key "opened_routes", "users"
  add_foreign_key "pois", "users"
  add_foreign_key "routes", "users"
  add_foreign_key "strava_activities", "users"
  add_foreign_key "strava_activity_peak_powers", "users"
  add_foreign_key "users", "chart_layouts", column: "last_chart_layout_id", on_delete: :nullify
end
