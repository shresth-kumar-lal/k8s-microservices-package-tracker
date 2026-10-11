FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    METRICS_PORT=9090

WORKDIR /usr/src/app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi \
    && npm cache clean --force

COPY --chown=node:node server.js validation.js ./
USER node

EXPOSE 3000 9090
CMD ["node", "server.js"]
