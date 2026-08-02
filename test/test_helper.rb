ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"

module ActiveSupport
  class TestCase
    # Exécute les tests d'un même fichier en parallèle (un worker par cœur).
    parallelize(workers: :number_of_processors)
  end
end
