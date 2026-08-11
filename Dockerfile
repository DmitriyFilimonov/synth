FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

EXPOSE 3000

ENV NODE_ENV=production

CMD ["npx", "tsx", "dist/server.js"]