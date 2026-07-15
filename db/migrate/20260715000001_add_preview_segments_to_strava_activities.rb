class AddPreviewSegmentsToStravaActivities < ActiveRecord::Migration[8.1]
  def up
    add_column :strava_activities, :preview_segments, :jsonb

    # Backfill so existing activities show their track thumbnail without waiting
    # for a re-sync. Prefers persisted streams (elevation-coloured) and falls
    # back to the summary polyline (plain track shape).
    say_with_time "Backfilling strava_activities.preview_segments" do
      StravaActivity.reset_column_information
      count = 0
      StravaActivity.find_each do |activity|
        activity.update_column(:preview_segments, activity.compute_preview_segments)
        count += 1
      end
      count
    end
  end

  def down
    remove_column :strava_activities, :preview_segments
  end
end
