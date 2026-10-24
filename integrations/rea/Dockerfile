# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

RUN --mount=type=secret,id=proxy_ca,required=true \
    apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca update \
    && apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca install -y --no-install-recommends procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/rea
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca,required=true \
    NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca \
    npm ci --strict-ssl=true --omit=optional --ignore-scripts \
    && npm cache clean --force

ENV PATH="/opt/rea/node_modules/.bin:${PATH}"
WORKDIR /tmp
ENTRYPOINT ["rea"]
