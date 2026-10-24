# syntax=docker/dockerfile:1
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /opt
RUN --mount=type=secret,id=proxy_ca,required=true \
    NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca \
    npm install --prefix /opt/openclaw --engine-strict --ignore-scripts --omit=dev --no-audit --no-fund --strict-ssl=true openclaw@2026.10.7
RUN --mount=type=secret,id=proxy_ca,required=true \
    NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca \
    npm install --prefix /opt/dsh --engine-strict --ignore-scripts --omit=dev --no-audit --no-fund --strict-ssl=true @deepseek-ai/dsh@0.2.1-rc.2
RUN --network=none node /opt/openclaw/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs
ENV PATH="/opt/openclaw/node_modules/.bin:/opt/dsh/node_modules/.bin:${PATH}"
USER node
WORKDIR /home/node
CMD ["node", "--version"]
