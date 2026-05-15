class AddLastChartLayoutToUsers < ActiveRecord::Migration[8.1]
  def change
    add_reference :users, :last_chart_layout,
      null: true,
      foreign_key: { to_table: :chart_layouts, on_delete: :nullify }
  end
end
