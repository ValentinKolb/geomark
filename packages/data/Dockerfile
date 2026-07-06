FROM oven/bun:1 AS base
WORKDIR /app

# unzip + zstd are runtime deps (extract + compress stages shell out)
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip zstd ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS install
# Copy every workspace package.json so Bun can validate the workspace
# topology against bun.lock. Without all of them, --frozen-lockfile fails
# because the lockfile expects api/ and web/ to be visible as workspaces.
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/data/package.json packages/data/
RUN bun install --frozen-lockfile --production

FROM base AS release
ENV NODE_ENV=production

# Bun hoists all workspace deps into the root node_modules in production
# install mode, so we only need to copy that one tree (no per-workspace
# node_modules are created in Docker even though they exist locally).
COPY --from=install /app/node_modules ./node_modules
COPY packages/shared ./packages/shared
COPY packages/data ./packages/data
COPY package.json ./

# Default data dir for output volume — make sure the unprivileged `bun`
# user owns it. Mounted volumes (PVC/emptyDir) inherit ownership of the
# directory's mountpoint, so we chown both the parent and the dir itself.
RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun

WORKDIR /app/packages/data
EXPOSE 3000/tcp
VOLUME ["/data"]

# Liveness probe via Bun fetch — no external curl/wget dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e 'fetch("http://localhost:3000/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["bun", "src/index.ts"]
