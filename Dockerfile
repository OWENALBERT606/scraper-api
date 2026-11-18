FROM node:20-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PORT=3000 IMPORT_DATA_DIR=/app/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
# the ledger of imported films lives here: mount a persistent volume on /app/data
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
