# syntax=docker/dockerfile:1
ARG PYTHON_IMAGE=python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
# Export on the builder architecture; uv itself is not required on the target.
FROM --platform=$BUILDPLATFORM ${PYTHON_IMAGE} AS lock-export
RUN python -m pip install --no-cache-dir uv==0.13.1
WORKDIR /lock
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv export --locked --no-dev --no-emit-project --format requirements-txt -o runtime.txt > /dev/null \
    && uv export --locked --no-emit-project --format requirements-txt -o test.txt > /dev/null

FROM ${PYTHON_IMAGE} AS dependencies
COPY --from=lock-export /lock/runtime.txt /tmp/requirements.txt
# Fail rather than silently compile or replace a missing architecture wheel.
RUN python -m pip install --no-cache-dir --require-hashes --only-binary=:all: \
    --no-deps --target /opt/deps -r /tmp/requirements.txt

FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/deps:/app/backend REPO_ROOT=/app \
    SHARED_DATA_DIR=/data SQLITE_PATH=/data/firewatch.sqlite3 \
    JOB_ENABLED=false SCHEDULER_OWNER=unassigned ALLOW_FIXTURE_DATA=false
WORKDIR /app/backend
RUN groupadd --gid 10001 firewatch && useradd --uid 10001 --gid 10001 --no-create-home firewatch \
    && mkdir /data && chown 10001:10001 /data
COPY --from=dependencies /opt/deps /opt/deps
COPY backend/app /app/backend/app
COPY frontend/public/data /app/frontend/public/data
COPY deploy/worker.py deploy/healthcheck.py /app/deploy/
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=3 \
    CMD ["python", "/app/deploy/healthcheck.py", "api"]
CMD ["python", "-m", "uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--no-proxy-headers"]

FROM runtime AS test
HEALTHCHECK NONE
USER root
COPY --from=lock-export /lock/test.txt /tmp/test-requirements.txt
RUN python -m pip install --no-cache-dir --require-hashes --only-binary=:all: \
    --no-deps --target /opt/deps --upgrade -r /tmp/test-requirements.txt
COPY backend/tests /app/backend/tests
COPY backend/scripts/smoke.py /app/backend/scripts/smoke.py
COPY backend/pyproject.toml /app/backend/pyproject.toml
COPY shared/examples /app/shared/examples
COPY shared/schemas /app/shared/schemas
USER 10001:10001
CMD ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider"]
