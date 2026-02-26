FROM node:22-slim

WORKDIR /app

# Install soulprint-network from npm
RUN npm install -g soulprint-network@latest

# Default port
ENV SOULPRINT_PORT=4888
EXPOSE 4888

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.SOULPRINT_PORT+'/info', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "/usr/local/lib/node_modules/soulprint-network/dist/server.js"]
