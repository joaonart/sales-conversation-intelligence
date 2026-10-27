FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY packages/evaluation-core /tmp/core
COPY packages/bigquery-adapter /tmp/bq
COPY apps/workers /tmp/workers
RUN pip install --no-cache-dir /tmp/core /tmp/bq /tmp/workers && rm -rf /tmp/core /tmp/bq /tmp/workers
RUN useradd --create-home appuser
USER appuser
ENTRYPOINT ["python", "-m", "sci_workers.historical_main"]
