FROM node:24.11.0-bookworm-slim AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci


FROM dependencies AS packs

COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /usr/local/bin/uv
# Rasterio's pinned release builds from source on Linux ARM64.
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool ca-certificates g++ libgdal-dev \
    && rm -rf /var/lib/apt/lists/*

ENV UV_PROJECT_ENVIRONMENT=/opt/dem \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_CACHE_DIR=/tmp/uv-cache
COPY tools/dem/pyproject.toml tools/dem/uv.lock ./tools/dem/
RUN uv sync --frozen --project tools/dem --python 3.12 \
    && chmod -R a+rX /opt/dem /opt/python

ENV UV_NO_SYNC=1
COPY tsconfig.json ./
COPY lib ./lib
COPY scripts ./scripts
COPY data ./data
COPY tools/dem/sample_dem.py ./tools/dem/
RUN rm -rf /tmp/uv-cache \
    && mkdir -p .local-data/runtime && chown node:node .local-data/runtime

ENTRYPOINT ["node", "--import", "tsx"]
CMD ["scripts/manage-packs.ts", "list"]


FROM node:24.11.0-bookworm-slim AS build

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

RUN npm run build


FROM node:24.11.0-bookworm-slim AS runtime

WORKDIR /app

ENV HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    PORT=3000

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/data ./data
COPY --from=build --chown=node:node /app/lib ./lib
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/next.config.ts ./next.config.ts
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/tsconfig.json ./

RUN mkdir -p .local-data/packs .local-data/runtime \
    && chown -R node:node .local-data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["npm", "start"]
