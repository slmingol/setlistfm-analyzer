FROM node:22-alpine AS builder

WORKDIR /app

# native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package.json .
RUN npm install --omit=dev

# ---- runtime image ----
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json .
COPY src/ ./src/
COPY public/ ./public/
COPY top_artists.json .

RUN mkdir -p /app/data

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

EXPOSE 3000

CMD ["node", "src/index.js"]
