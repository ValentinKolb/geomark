FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile

FROM install AS build
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web
WORKDIR /app/packages/web
RUN bun run build:css

FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=install /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web
COPY package.json ./

WORKDIR /app/packages/web
EXPOSE 3000/tcp
CMD ["bun", "src/index.ts"]
