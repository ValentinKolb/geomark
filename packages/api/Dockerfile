FROM oven/bun:1 AS base
WORKDIR /app

# zstd is needed at runtime — the loader spawns `zstd -dcq` to decompress
# downloaded shards before INSERTing. ca-certificates lets HTTPS fetches
# (e.g. against the data service if it's deployed with TLS) work.
RUN apt-get update && apt-get install -y --no-install-recommends \
    zstd ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS install
# Copy every workspace package.json so Bun can validate the workspace
# topology against bun.lock. --frozen-lockfile fails if any workspace
# referenced in the lock isn't visible.
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/data/package.json packages/data/
RUN bun install --frozen-lockfile --production

FROM base AS release
# Bun hoists workspace deps into root node_modules — copy that one tree.
COPY --from=install /app/node_modules ./node_modules
COPY packages/shared ./packages/shared
COPY packages/api ./packages/api
COPY package.json ./

# Run as the unprivileged `bun` user provided by the base image.
RUN chown -R bun:bun /app
USER bun

WORKDIR /app/packages/api
EXPOSE 3000/tcp

# Liveness probe via Bun fetch — no external curl/wget dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e 'fetch("http://localhost:3000/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["bun", "src/index.ts"]
