# Stage 1: build dependencies
FROM python:3.12-slim AS builder

WORKDIR /build

COPY pyproject.toml .
RUN pip install --no-cache-dir --prefix=/install .

# Stage 2: runtime image
FROM python:3.12-slim AS runtime

RUN groupadd -r compass && useradd -r -g compass compass

WORKDIR /code

COPY --from=builder /install /usr/local

COPY app/ ./app/
COPY alembic/ ./alembic/
COPY alembic.ini .
COPY scripts/ ./scripts/

USER compass

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--proxy-headers", "--forwarded-allow-ips", "*"]
