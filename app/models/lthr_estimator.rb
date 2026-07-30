# Estimation du seuil cardiaque (LTHR — Lactate Threshold Heart Rate) d'UNE sortie,
# à partir de son flux de FC. Pendant que `FtpEstimator` répond « quelle puissance
# cette sortie prouve », ce module répond la même chose côté cardio.
#
# Deux ancres, dans l'esprit des protocoles de terrain :
#   • FC moyenne d'un effort d'~1 h (Coggan) — la meilleure ancre quand elle existe
#   • FC moyenne du meilleur 20 min × 0,98 (Friel : le LTHR est la FC moyenne des
#     20 dernières minutes d'un contre-la-montre de 30 min, soit un poil sous la
#     moyenne d'un 20 min maximal)
# On garde la plus haute des deux : chacune est un *plancher* de ce que l'athlète
# a tenu, jamais un plafond.
#
# ⚠ Comme la FTP d'une sortie, la valeur n'a de sens que si l'effort a été
# soutenu : une sortie tranquille donne mécaniquement un seuil bas. C'est au front
# de le présenter comme « ce que cette sortie prouve », pas comme LE seuil.
module LthrEstimator
  module_function

  LTHR_20MIN_FACTOR = 0.98 # LTHR ≈ 98 % de la FC moyenne d'un 20 min maximal
  LTHR_60MIN_FACTOR = 1.0  # un effort d'~1 h se court déjà au seuil
  # Durées des ancres (s). Le 20 min est la plus courte fenêtre où la FC a fini de
  # dériver vers son palier ; en deçà on lirait surtout l'inertie cardiaque.
  DURATIONS = [1200, 3600].freeze
  # Plancher de vraisemblance : sous 100 bpm sur 20 min, c'est une sortie de
  # récupération (ou un cardio qui décroche), pas un effort au seuil.
  MIN_PLAUSIBLE_BPM = 100

  # `streams` = les flux bruts de la sortie ({ "time" =>, "heartrate" => }, chacun
  # tableau nu ou enveloppé dans `{ "data" => [...] }`). Renvoie nil sans FC
  # exploitable, sinon :
  #   { bpm:, method: 'lthr_20min'|'lthr_60min', best_20min:, best_60min:,
  #     max_hr:, durations: [durées ayant porté l'estimation] }
  def estimate_from_streams(streams)
    curve = PeakPowerCurve.mean_max(streams, 'heartrate', DURATIONS)
    estimate_from_curve(curve, max_hr: max_heartrate(streams))
  end

  # Même calcul à partir d'une courbe mean-max FC déjà calculée
  # ({ "1200" => bpm, … }) — le cœur testable, sans streams.
  def estimate_from_curve(curve, max_hr: nil)
    return nil unless curve.is_a?(Hash)

    best20 = numeric(curve['1200'] || curve[1200])
    best60 = numeric(curve['3600'] || curve[3600])

    candidates = {
      'lthr_60min' => best60 && best60 * LTHR_60MIN_FACTOR,
      'lthr_20min' => best20 && best20 * LTHR_20MIN_FACTOR
    }.compact.select { |_, v| v >= MIN_PLAUSIBLE_BPM }
    return nil if candidates.empty?

    method, bpm = candidates.max_by { |_, v| v }
    {
      bpm: bpm.round,
      method: method,
      best_20min: best20&.round,
      best_60min: best60&.round,
      max_hr: max_hr&.round,
      durations: [method == 'lthr_60min' ? 3600 : 1200]
    }
  end

  # FC max instantanée observée sur la sortie — contexte affiché à côté du seuil
  # (un seuil proche de la FC max signale un effort très soutenu).
  def max_heartrate(streams)
    values = PeakPowerCurve.stream_values(streams, 'heartrate') if streams.is_a?(Hash)
    return nil unless values.is_a?(Array)

    values.filter_map { |v| v.to_f if v.is_a?(Numeric) && v.finite? && v.positive? }.max
  end

  def numeric(value)
    return value.to_f if value.is_a?(Numeric)
    return value.to_f if value.is_a?(String) && value.match?(/\A-?\d+(\.\d+)?\z/)

    nil
  end
end
