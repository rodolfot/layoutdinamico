# ---- build ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
# compila TS -> dist/ (dist/src/*, dist/scripts/*) e copia os assets estaticos da UI
RUN npm run build && cp -r src/ui dist/src/ui

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
EXPOSE 3000
# oracledb roda em Thin mode (sem Instant Client)
ENTRYPOINT ["./docker-entrypoint.sh"]
