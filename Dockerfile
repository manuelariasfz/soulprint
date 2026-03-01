FROM node:22-slim

WORKDIR /app

# v0.4.5 — fixed workspace:* deps, compatible with npm global install
RUN npm install -g soulprint-network@0.4.6 --prefer-online

ENV SOULPRINT_PORT=4888
ENV PORT=4888
EXPOSE 4888

CMD ["node", "/usr/local/lib/node_modules/soulprint-network/dist/server.js"]
