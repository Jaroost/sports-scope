require "builder"

# Reconstruit un fichier TCX à partir des `streams` d'une activité importée (le .fit
# d'origine n'est pas conservé). TCX plutôt que GPX : il porte puissance (extension
# ActivityExtension/TPX), cadence et fréquence cardiaque. Sert à `StravaUploader`.
class TcxBuilder
  NS = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  EXT_NS = "http://www.garmin.com/xmlschemas/ActivityExtension/v2"

  # Sport TCX accepté par Strava : Running, Biking ou Other.
  def self.sport_for(activity_type)
    case PerformanceRecords.sport_category(activity_type)
    when "cycling" then "Biking"
    when "running", "hiking" then "Running"
    else "Other"
    end
  end

  def initialize(activity)
    @activity = activity
    @streams = activity.effective_streams.is_a?(Hash) ? activity.effective_streams : {}
  end

  # Faux s'il manque l'horodatage ou le temps : Strava refuse un fichier sans trackpoints.
  def buildable?
    @activity.started_at.present? && series("time").length >= 2
  end

  def to_xml
    time = series("time")
    latlng = series("latlng")
    alt = series("altitude")
    dist = series("distance")
    hr = series("heartrate")
    cad = series("cadence")
    watts = series("watts")
    start = @activity.started_at.utc

    xml = Builder::XmlMarkup.new(indent: 1)
    xml.instruct!(:xml, version: "1.0", encoding: "UTF-8")
    xml.TrainingCenterDatabase("xmlns" => NS, "xmlns:ns3" => EXT_NS) do
      xml.Activities do
        xml.Activity("Sport" => self.class.sport_for(@activity.activity_type)) do
          xml.Id(start.iso8601)
          xml.Lap("StartTime" => start.iso8601) do
            xml.TotalTimeSeconds((@activity.elapsed_time_s || time.last).to_f)
            xml.DistanceMeters(((@activity.distance_m || dist.last).to_f))
            xml.Intensity("Active")
            xml.TriggerMethod("Manual")
            xml.Track do
              time.each_with_index do |t, i|
                next if t.nil?

                xml.Trackpoint do
                  xml.Time((start + t.to_f).iso8601)
                  pos = latlng[i]
                  if pos.is_a?(Array) && pos.length == 2 && pos.all?
                    xml.Position do
                      xml.LatitudeDegrees(pos[0])
                      xml.LongitudeDegrees(pos[1])
                    end
                  end
                  xml.AltitudeMeters(alt[i]) unless alt[i].nil?
                  xml.DistanceMeters(dist[i]) unless dist[i].nil?
                  xml.HeartRateBpm { xml.Value(hr[i].round) } unless hr[i].nil?
                  xml.Cadence(cad[i].round) unless cad[i].nil?
                  unless watts[i].nil?
                    xml.Extensions { xml.tag!("ns3:TPX") { xml.tag!("ns3:Watts", watts[i].round) } }
                  end
                end
              end
            end
          end
        end
      end
    end
    xml.target!
  end

  private

  def series(key)
    data = @streams.dig(key, "data")
    data.is_a?(Array) ? data : []
  end
end
