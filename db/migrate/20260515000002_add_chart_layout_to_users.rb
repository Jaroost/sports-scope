class AddChartLayoutToUsers < ActiveRecord::Migration[8.1]
  def change
    add_column :users, :chart_layout, :jsonb
  end
end
