ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/stamp-install.mjs ./scripts/
RUN npm ci
COPY src ./src
COPY public ./public
COPY index.html tsconfig.json tsconfig.server.json vite.config.ts ./
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts/run.mjs scripts/install-data.mjs scripts/data-release.json ./scripts/
RUN mkdir -p /app/.local-data && chown node:node /app/.local-data
USER node
EXPOSE 3000
CMD ["node", "scripts/run.mjs"]
