FROM node:22-slim

WORKDIR /app

# Install soulprint-network from npm
RUN npm install -g soulprint-network@latest

# Verify install and find server path
RUN find /usr/local/lib/node_modules/soulprint-network/dist -name "server.js" | head -3

# Default port
ENV SOULPRINT_PORT=4888
ENV PORT=4888
EXPOSE 4888

# Health check — give extra time for blockchain connections on startup
HEALTHCHECK --interval=30s --timeout=15s --start-period=90s --retries=5 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||4888)+'/info', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "/usr/local/lib/node_modules/soulprint-network/dist/server.js"]
