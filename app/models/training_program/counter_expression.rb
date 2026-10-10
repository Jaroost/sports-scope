# Une expression de compteur de répétition, ce qu'il y a entre accolades dans un nom ou une
# description : `n1`, `n2-max`, `n1*n2`, `(n1-1)*n2-max+n2`… Opérandes : le tour d'un groupe
# (`n` = le plus proche, `n1`… = niveau 1 le plus extérieur) et son total (`-max`), plus des
# entiers ; opérateurs `+ - *` (priorité habituelle), parenthèses, moins unaire.
#
# `counters` : pour chaque groupe englobant, du plus extérieur au plus intérieur,
# `[tour, total]`. Le résultat est un entier, ou nil si l'expression est mal formée, vise un
# niveau qui n'existe pas, ou n'a aucun opérande `n` (`{12}` n'est pas à nous). Miroir de
# `evaluateCounterExpression` (trainingProgramStore.ts).
class TrainingProgram::CounterExpression
  TOKEN = /\A\s*(\d+|n[1-9]?(?:-max)?|[-+*()])/

  def self.evaluate(expression, counters)
    new(expression, counters).evaluate
  end

  def initialize(expression, counters)
    @expression = expression
    @counters = counters
  end

  def evaluate
    catch(:invalid) do
      @tokens = tokenize
      @pos = 0
      @used_counter = false
      value = parse_sum
      throw :invalid unless @pos == @tokens.size && @used_counter
      value
    end
  end

  private

  def tokenize
    tokens = []
    rest = @expression
    until rest.strip.empty?
      match = rest.match(TOKEN) or throw :invalid
      tokens << match[1]
      rest = match.post_match
    end
    tokens
  end

  def peek = @tokens[@pos]

  def advance
    @pos += 1
    @tokens[@pos - 1]
  end

  def parse_sum
    value = parse_product
    while %w[+ -].include?(peek)
      operator = advance
      right = parse_product
      value = operator == "+" ? value + right : value - right
    end
    value
  end

  def parse_product
    value = parse_factor
    value *= parse_factor while peek == "*" && advance
    value
  end

  def parse_factor
    token = advance or throw :invalid
    case token
    when "-" then -parse_factor
    when "(" then parse_sum.tap { advance == ")" or throw :invalid }
    when /\A\d+\z/ then token.to_i
    when /\An/ then counter(token)
    else throw :invalid
    end
  end

  def counter(token)
    level, max = token.match(/\An([1-9])?(-max)?\z/).captures
    round = @counters[level ? level.to_i - 1 : @counters.size - 1] or throw :invalid
    @used_counter = true
    round[max ? 1 : 0]
  end
end
