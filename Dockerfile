FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Also pulls in the SDK's bundled Claude Code binary for this platform.
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENV HOME=/home/node PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
