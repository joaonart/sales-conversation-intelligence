FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Build from the repository root: docker build -f apps/workers/Dockerfile .
WORKDIR /app
COPY packages/evaluation-core /tmp/core
COPY packages/bigquery-adapter /tmp/bq
COPY packages/openai-adapter /tmp/openai
COPY apps/workers /tmp/workers
RUN pip install --no-cache-dir /tmp/core /tmp/bq /tmp/openai /tmp/workers && rm -rf /tmp/core /tmp/bq /tmp/openai /tmp/workers
RUN useradd --create-home appuser
USER appuser
ENTRYPOINT ["python", "-m"]
CMD ["sci_workers.historical_main"]  # live service overrides: sci_workers.live_main
