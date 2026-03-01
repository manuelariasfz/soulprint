FROM node:22-slim

WORKDIR /app

# v0.6.0 — pure blockchain architecture, libp2p removed, 10x simpler
RUN npm install -g soulprint-network@0.6.0 --prefer-online

ENV SOULPRINT_PORT=4888
ENV PORT=4888
EXPOSE 4888

CMD ["node", "/usr/local/lib/node_modules/soulprint-network/dist/server.js"]
