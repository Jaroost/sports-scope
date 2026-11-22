class CreateFriendInvitations < ActiveRecord::Migration[8.1]
  def change
    # Invitation par mail à une adresse sans compte : à la création du compte, elle
    # devient une demande d'ami (cf. User#claim_friend_invitations).
    create_table :friend_invitations do |t|
      t.references :inviter, null: false, foreign_key: { to_table: :users }
      t.string :email, null: false
      t.datetime :last_sent_at, null: false
      t.timestamps
    end
    add_index :friend_invitations, %i[inviter_id email], unique: true
    add_index :friend_invitations, :email
  end
end
