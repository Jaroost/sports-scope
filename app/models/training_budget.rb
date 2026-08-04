# Le budget de charge calculé par `useTrainingPlan.ts` (cible du jour, plafond de
# fatigue, cible/fait/prévu/reste de la semaine, plan jour par jour), tel que
# `TrainingBudgetsController` le reçoit et le persiste sur `users.training_budget`
# pour l'app compagnon (cf. `CompanionSettingsController#show`).
#
# **Le calcul n'est pas ici.** CTL/ATL, plancher de fatigue selon l'objectif, cible
# hebdomadaire, affûtage : tout ça reste en TypeScript (`useTrainingPlan.ts`) — voir
# le commentaire au-dessus de `pushTrainingBudget` dans `companionBridge.ts` sur
# pourquoi cette logique ne doit pas exister en deux exemplaires. Ce module ne fait
# que vérifier la FORME d'un document déjà calculé avant de l'écrire en base.
#
# Contrairement à `CompanionSettings.sanitize`, qui fabrique toujours quelque chose
# d'affichable, un document illisible ici est **rejeté** plutôt que remplacé par un
# budget inventé : un chiffre de charge fabriqué induirait en erreur, alors que
# « pas de budget » est déjà un état géré des deux côtés (le composant compagnon a
# un état vide dédié, cf. `CompanionSettings::BLOCKS["training_budget"]`).
module TrainingBudget
  MAX_DAYS = 7
  DATE_RE = /\A\d{4}-\d{2}-\d{2}\z/

  module_function

  def sanitize(raw)
    return nil unless raw.is_a?(Hash)

    date = date_string(raw["date"])
    day = sanitize_amounts(raw["day"], %w[done target max])
    week = sanitize_amounts(raw["week"], %w[target done planned remaining])
    form = sanitize_form(raw["form"])
    return nil unless date && day && week && form

    {
      "date" => date,
      "day" => day,
      "week" => week,
      "form" => form,
      "risk" => sanitize_risk(raw["risk"]),
      "days" => sanitize_days(raw["days"])
    }.compact
  end

  # Toutes les clés attendues, numériques et non négatives — sinon le bloc entier
  # est rejeté (un plafond ou une cible manquants ne veulent rien dire à moitié).
  def sanitize_amounts(raw, keys)
    return nil unless raw.is_a?(Hash)

    keys.each_with_object({}) do |key, out|
      value = numeric(raw[key])
      return nil unless value

      out[key] = value.negative? ? 0.0 : value
    end
  end

  def sanitize_form(raw)
    return nil unless raw.is_a?(Hash)
    return nil unless raw["zone"].is_a?(String)

    ctl = numeric(raw["ctl"])
    atl = numeric(raw["atl"])
    tsb = numeric(raw["tsb"])
    return nil unless ctl && atl && tsb

    { "ctl" => ctl, "atl" => atl, "tsb" => tsb, "zone" => raw["zone"] }
  end

  # `risk` est nullable par construction côté TS (ACWR pas encore mesurable pour un
  # compte récent) : une valeur absente ou mal formée retombe simplement sur rien,
  # sans faire échouer le reste du document.
  def sanitize_risk(raw)
    return nil unless raw.is_a?(Hash)

    { "acwr" => numeric(raw["acwr"]), "zone" => raw["zone"].is_a?(String) ? raw["zone"] : nil }
  end

  # Le plan jour par jour de la semaine en cours. Une entrée mal formée est
  # simplement ignorée plutôt que d'invalider tout le document — un seul jour
  # douteux ne doit pas faire perdre le reste de la semaine.
  def sanitize_days(raw)
    return nil unless raw.is_a?(Array)

    raw.first(MAX_DAYS).filter_map do |entry|
      next nil unless entry.is_a?(Hash)

      date = date_string(entry["date"])
      next nil unless date

      { "date" => date, "target" => numeric(entry["target"]), "done" => numeric(entry["done"]) }
    end
  end

  def date_string(raw)
    raw.is_a?(String) && DATE_RE.match?(raw) ? raw : nil
  end

  def numeric(value)
    Float(value)
  rescue ArgumentError, TypeError
    nil
  end
end
