FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Web frontend
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web/ ./web/
RUN cd web && npm run build

# Backend
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
