FROM node:22-slim

WORKDIR /app

# v0.5.0 — 4-node validator network, Registraduría cédula validation, stable release
RUN npm install -g soulprint-network@0.5.1 --prefer-online

ENV SOULPRINT_PORT=4888
ENV PORT=4888
EXPOSE 4888

CMD ["node", "/usr/local/lib/node_modules/soulprint-network/dist/server.js"]
