# syntax=docker/dockerfile:1
FROM node:22-alpine
ARG VERSION=dev
WORKDIR /app
COPY server.mjs .
ENV NODE_ENV=production PORT=8080 VERSION=$VERSION
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
