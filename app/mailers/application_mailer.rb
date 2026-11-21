class ApplicationMailer < ActionMailer::Base
  # Gmail réécrit l'expéditeur : SMTP_FROM doit être l'adresse du compte (ou un alias validé).
  default from: ENV.fetch("SMTP_FROM") { ENV.fetch("SMTP_USER", "from@example.com") }
  layout "mailer"
end
