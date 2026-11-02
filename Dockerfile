FROM node:24-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 COREPACK_HOME=/usr/local/share/corepack
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack install

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY apps/web ./apps/web
COPY packages ./packages
COPY services/worker ./services/worker
COPY scripts ./scripts
COPY docs/openapi.json ./docs/openapi.json
RUN pnpm build

FROM base
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
