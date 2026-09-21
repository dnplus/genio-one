FROM oven/bun:1.4.2 AS build

WORKDIR /workspace

RUN bun add --global pnpm@12.4.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bot/package.json apps/bot/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
RUN pnpm install --frozen-lockfile --filter genio-one-bot...

COPY apps/bot apps/bot
COPY runtimes/gateway/services/shared runtimes/gateway/services/shared
COPY packages packages
RUN cd apps/bot \
    && bun x vite build \
    && bun build server/index.ts --target=bun --outdir=dist/server

FROM oven/bun:1.4.2 AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    GENIO_BOT_HOST=0.0.0.0 \
    GENIO_BOT_PORT=5181 \
    GENIO_BOT_CODEX_COMMAND=codex \
    GENIO_BOT_DEMO_CATALOG=/app/demo/catalog.json \
    PATH="/root/.bun/bin:${PATH}"

COPY --from=build /workspace/apps/bot/package.json ./package.json

RUN bun add -g @openai/codex@$(bun -e 'console.log(require("./package.json").devDependencies["@openai/codex"])') \
    && mkdir -p /var/lib/genio-one-bot/codex-home \
    && mkdir -p /var/lib/genio-one-bot/artifacts \
    && mkdir -p /var/lib/genio-one-bot/bot-packages

COPY --from=build /workspace/apps/bot/dist ./dist
COPY --from=build /workspace/apps/bot/demo ./demo

EXPOSE 5181
CMD ["bun", "dist/server/index.js"]
