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

ActiveRecord::Schema[8.1].define(version: 2026_06_17_000002) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

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

  create_table "routes", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.float "distance_m"
    t.float "elevation_gain_m"
    t.float "elevation_loss_m"
    t.jsonb "geometry", default: [], null: false
    t.string "name", null: false
    t.string "profile", default: "cycling"
    t.string "share_token", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.jsonb "voice_hints", default: [], null: false
    t.jsonb "waypoints", default: [], null: false
    t.index ["share_token"], name: "index_routes_on_share_token", unique: true
    t.index ["user_id", "updated_at"], name: "index_routes_on_user_id_and_updated_at"
    t.index ["user_id"], name: "index_routes_on_user_id"
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
    t.jsonb "chart_layout"
    t.datetime "created_at", null: false
    t.string "display_name"
    t.string "email", null: false
    t.string "keycloak_uid", null: false
    t.bigint "last_chart_layout_id"
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

  add_foreign_key "chart_layouts", "users"
  add_foreign_key "imported_activities", "users"
  add_foreign_key "routes", "users"
  add_foreign_key "strava_activity_peak_powers", "users"
  add_foreign_key "users", "chart_layouts", column: "last_chart_layout_id", on_delete: :nullify
end
