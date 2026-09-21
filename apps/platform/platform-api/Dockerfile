FROM oven/bun:1.4.2 AS build

WORKDIR /workspace

# pnpm remains the monorepo dependency and lockfile authority. Bun owns the
# TypeScript runtime and bundling loop inside this image.
RUN bun add --global pnpm@12.4.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/platform/package.json apps/platform/package.json
COPY apps/connectors/package.json apps/connectors/package.json
COPY runtimes/gateway/package.json runtimes/gateway/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
RUN pnpm install --filter @genioone/gateway... --frozen-lockfile --filter genio-one... --filter genio-connectors...

COPY apps/platform/management.html apps/platform/management.html
COPY apps/platform/tsconfig.json apps/platform/tsconfig.json
COPY apps/platform/vite.config.ts apps/platform/vite.config.ts
COPY docs/public/product docs/public/product
COPY packages packages
COPY apps/platform/platform-web apps/platform/platform-web
COPY runtimes/gateway/services runtimes/gateway/services
COPY apps/platform/platform-api apps/platform/platform-api
COPY apps/connectors/mail2000/site.ts ./apps/connectors/mail2000/site.ts
COPY apps/connectors/configuration.ts apps/connectors/configuration.ts
COPY apps/connectors/discovery apps/connectors/discovery
RUN cd apps/platform \
    && bun run build:web \
    && bun run build:api \
    && bun build platform-api/src/migrate.ts --target=bun --outdir=platform-api/dist \
    && bun build platform-api/src/pricing-sync.ts --target=bun --outdir=platform-api/dist

FROM oven/bun:1.4.2 AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    GENIO_ONE_PLATFORM_API_MODE=postgres \
    GENIO_ONE_MANAGEMENT_API_HOST=0.0.0.0 \
    GENIO_ONE_MANAGEMENT_API_PORT=8080 \
    GENIO_ONE_PLATFORM_MIGRATIONS_DIR=/app/migrations \
    GENIO_ONE_SWAGGER_UI_STATIC_DIR=/app/swagger-ui-static \
    GENIO_ONE_WEB_HTML_FILE=/app/dist/web/management.html

COPY --from=build --chown=bun:bun /workspace/apps/platform/platform-api/dist ./dist
COPY --from=build --chown=bun:bun /workspace/apps/platform/platform-api/migrations ./migrations
COPY --from=build --chown=bun:bun /workspace/node_modules/.pnpm/@fastify+swagger-ui@6.1.1/node_modules/@fastify/swagger-ui/static ./swagger-ui-static

USER bun
EXPOSE 8080
CMD ["bun", "dist/server.js"]
