FROM node:22-alpine

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY src/ ./src/
COPY public/ ./public/

# data/ is mounted at runtime (contains top_artists.json and tours.db)
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/index.js"]
