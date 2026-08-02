# Passage de session du navigateur à l'application mobile.
#
# Chrome et le WebView de l'appli ont deux pots de cookies distincts : être connecté
# sur le site ne se voit pas dans l'appli. Plutôt que de faire retaper un mot de passe
# à chaque installation, la page de partage émet ici un jeton à usage unique et de
# courte durée, que l'appli échange contre une vraie session (cf. SessionsController#handoff).
#
# Seule l'empreinte du jeton est stockée, comme pour un mot de passe : une copie de la
# base ne donne aucun jeton utilisable. `consumed_at` porte l'usage unique — c'est un
# UPDATE conditionnel qui le garantit, pas une lecture suivie d'une écriture.
class CreateSessionHandoffs < ActiveRecord::Migration[8.1]
  def change
    create_table :session_handoffs do |t|
      t.references :user, null: false, foreign_key: true
      t.string :token_digest, null: false
      t.datetime :expires_at, null: false
      t.datetime :consumed_at
      t.timestamps
    end

    # Unique : le jeton est la clé de recherche, et deux lignes ne peuvent pas
    # porter la même empreinte.
    add_index :session_handoffs, :token_digest, unique: true
    # Purge des jetons périmés (cf. SessionHandoff.issue!).
    add_index :session_handoffs, :expires_at
  end
end
