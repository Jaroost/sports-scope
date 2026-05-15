# syntax=docker/dockerfile:1
FROM ruby:3.3-slim

ENV LANG=C.UTF-8 \
    BUNDLE_PATH=/usr/local/bundle \
    BUNDLE_JOBS=4 \
    NODE_VERSION=22 \
    PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:$PATH

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      build-essential \
      curl \
      git \
      libpq-dev \
      libyaml-dev \
      pkg-config \
      ca-certificates \
      gnupg \
      tzdata \
      postgresql-client && \
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - && \
    apt-get install --no-install-recommends -y nodejs && \
    corepack enable && \
    corepack prepare pnpm@9.12.0 --activate && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY bin/docker-entrypoint-rails /usr/local/bin/docker-entrypoint-rails
COPY bin/docker-entrypoint-vite /usr/local/bin/docker-entrypoint-vite
RUN chmod +x /usr/local/bin/docker-entrypoint-rails /usr/local/bin/docker-entrypoint-vite

EXPOSE 3000 3036

CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "3000"]
