# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
ARG SERVICE
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY services ./services
COPY simulator ./simulator
COPY tools ./tools
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@linesentry/${SERVICE}..." build
RUN pnpm deploy --filter "@linesentry/${SERVICE}" --prod /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "dist/index.js"]
