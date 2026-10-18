# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315
ARG NGINX_IMAGE=nginx:1.30-trixie@sha256:eb1c896deef834f4e056829fd6dadac8305501f16cc71ba65fb252c8d0aa168e
# Static assets are architecture independent. Build with native tooling, even
# when targeting s390x; no Node binaries are copied into the target image.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS sources
WORKDIR /frontend
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 VITE_API_BASE_URL=/api/v1
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./

FROM sources AS test
# Bound test concurrency on Docker Desktop/builders exposing many host CPUs.
# Preserve the normal test timeout and all assertions.
CMD ["npm", "test", "--", "--maxWorkers=2"]

FROM sources AS build
RUN npm run typecheck && npm run build -- --config vite.docker.config.ts

FROM ${NGINX_IMAGE} AS runtime
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=0755 deploy/nginx-entrypoint.sh /usr/local/bin/firewatch-nginx-entrypoint
COPY --from=build /frontend/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["curl", "--fail", "--silent", "http://127.0.0.1:8080/healthz"]
ENTRYPOINT ["/usr/local/bin/firewatch-nginx-entrypoint"]
CMD ["-g", "daemon off;"]
