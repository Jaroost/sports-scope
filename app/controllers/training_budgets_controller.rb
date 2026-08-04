# Le budget de charge, tel que `useTrainingPlan.ts` l'a calculé côté navigateur, et
# que le site persiste pour pouvoir le transmettre à l'appli compagnon via
# `/api/companion_settings` — sans dépendre d'une navigation WebView pour être
# frais (cf. `CompanionSettingsController`, `TrainingBudget`).
#
# Écriture seule et silencieuse : rien ne lit ce document depuis le site, il n'y a
# donc ni `show` ni rendu, seulement l'écriture best-effort déclenchée par
# `useTrainingPlan.ts` à chaque recalcul.
class TrainingBudgetsController < ApplicationController
  before_action :require_login!

  # PATCH /api/training_budget
  #
  # Un corps illisible ou dont la forme ne correspond pas **ne touche à rien** —
  # même piège que `CompanionSettingsController#update` : mieux vaut garder le
  # dernier budget connu qu'en écrire un à moitié compris.
  def update
    raw = payload
    sanitized = raw.is_a?(Hash) ? TrainingBudget.sanitize(raw) : nil
    return render json: { error: "malformed" }, status: :bad_request unless sanitized

    current_user.update_column(:training_budget, sanitized)
    head :no_content
  end

  private

  # Le corps brut plutôt que `params` : même raison que
  # `CompanionSettingsController#payload`, un document imbriqué de forme libre.
  def payload
    JSON.parse(request.raw_post)["budget"]
  rescue JSON::ParserError
    nil
  end
end
