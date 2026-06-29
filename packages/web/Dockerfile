FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
COPY packages/api/package.json packages/api/
COPY packages/data/package.json packages/data/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile

FROM install AS build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web
WORKDIR /app/packages/web
ENV NODE_ENV=production
RUN bun run build

FROM base AS release
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=install /app/node_modules ./node_modules
COPY packages/shared ./packages/shared
COPY packages/web/package.json ./packages/web/package.json
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY package.json ./

WORKDIR /app/packages/web
EXPOSE 3000/tcp
CMD ["bun", "dist/server.js"]
