FROM node:22.23.2-bookworm-slim AS build
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json README.md LICENSE .env.example ./
COPY docs ./docs
COPY src ./src
RUN npm run build && npm pack --ignore-scripts --pack-destination /tmp
FROM node:22.23.2-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /tmp/mcp-video-recognition-2.0.0.tgz /tmp/package.tgz
RUN npm install --omit=dev --ignore-scripts /tmp/package.tgz && rm /tmp/package.tgz && mkdir /media && chown node:node /media
ENV PATH="/app/node_modules/.bin:${PATH}"
USER node
CMD ["mcp-video-recognition"]
FROM runtime AS acceptance
COPY scripts/package-acceptance.mjs /app/package-acceptance.mjs
CMD ["node", "/app/package-acceptance.mjs", "/app/node_modules/mcp-video-recognition"]
FROM runtime AS release
