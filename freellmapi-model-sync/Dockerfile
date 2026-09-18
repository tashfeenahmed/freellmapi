FROM node:20-alpine

WORKDIR /app

# No dependencies — sync.js uses only Node 20 built-ins (fs, path, fetch).
COPY package.json sync.js ./

RUN mkdir -p /app/state

CMD ["node", "sync.js"]
