FROM node:20-alpine AS builder

WORKDIR /app

COPY . .

RUN npm install
RUN npm run build


FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder /app .

RUN mkdir -p /app/data

EXPOSE 3001

CMD ["node", "server/dist/index.js"]
