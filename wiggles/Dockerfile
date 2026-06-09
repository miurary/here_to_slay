FROM node:20-alpine AS build
WORKDIR /app/wiggles
COPY wiggles/package*.json ./
RUN npm ci
WORKDIR /app
COPY wiggles/ ./wiggles/
COPY shared/ ./shared/
WORKDIR /app/wiggles
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app/wiggles
COPY wiggles/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/wiggles/dist ./dist
COPY wiggles/src/cards ./dist/wiggles/src/cards
EXPOSE 3001
CMD ["node", "dist/wiggles/src/server.js"]
