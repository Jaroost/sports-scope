require "test_helper"

# Le jeton qui fait passer une session du navigateur à l'application mobile.
# Ce qui compte ici tient en trois propriétés : il ne sert qu'une fois, il périme,
# et il n'est jamais stocké en clair.
class SessionHandoffTest < ActiveSupport::TestCase
  def user(suffix = "a")
    User.create!(email: "handoff-#{suffix}@example.com", keycloak_uid: "kc-handoff-#{suffix}")
  end

  test "un jeton fraîchement émis rend son utilisateur" do
    owner = user
    token = SessionHandoff.issue!(owner)

    assert_equal owner, SessionHandoff.claim!(token)
  end

  test "le jeton n'est jamais stocké en clair" do
    token = SessionHandoff.issue!(user)

    handoff = SessionHandoff.last
    assert_not_equal token, handoff.token_digest
    assert_equal Digest::SHA256.hexdigest(token), handoff.token_digest
  end

  test "un jeton ne sert qu'une fois" do
    owner = user
    token = SessionHandoff.issue!(owner)

    assert_equal owner, SessionHandoff.claim!(token)
    assert_nil SessionHandoff.claim!(token)
  end

  test "un jeton périmé ne vaut rien" do
    owner = user
    token = SessionHandoff.issue!(owner)
    SessionHandoff.last.update!(expires_at: 1.second.ago)

    assert_nil SessionHandoff.claim!(token)
  end

  test "un jeton inconnu ou vide ne vaut rien" do
    assert_nil SessionHandoff.claim!("jeton-inventé")
    assert_nil SessionHandoff.claim!("")
    assert_nil SessionHandoff.claim!(nil)
  end

  test "deux jetons émis pour le même utilisateur sont distincts" do
    owner = user
    assert_not_equal SessionHandoff.issue!(owner), SessionHandoff.issue!(owner)
  end

  test "émettre purge les jetons périmés" do
    owner = user
    SessionHandoff.issue!(owner)
    SessionHandoff.last.update!(expires_at: 1.hour.ago)

    SessionHandoff.issue!(owner)

    assert_equal 1, SessionHandoff.where(user: owner).count
  end

  test "un jeton consommé reste en base jusqu'à sa péremption" do
    # Sa ligne est ce qui fait échouer une deuxième tentative : la supprimer
    # aussitôt rouvrirait la porte à un doublon portant la même empreinte.
    owner = user
    token = SessionHandoff.issue!(owner)
    SessionHandoff.claim!(token)

    assert_not_nil SessionHandoff.last.consumed_at
    assert_nil SessionHandoff.claim!(token)
  end
end
