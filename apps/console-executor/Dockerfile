FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Build from the repository root: docker build -f apps/console-executor/Dockerfile -t <repo>/console-executor:<tag> .
# A Cloud Run Job that polls the console's execution requests (run_requests), runs the approved ones and exits. No server, nothing listens.
WORKDIR /app
COPY packages/evaluation-core /tmp/core
COPY packages/bigquery-adapter /tmp/bq
COPY packages/openai-adapter /tmp/openai
COPY apps/workers /tmp/workers
COPY apps/console-executor /tmp/executor
RUN pip install --no-cache-dir /tmp/core /tmp/bq /tmp/openai /tmp/workers /tmp/executor && rm -rf /tmp/core /tmp/bq /tmp/openai /tmp/workers /tmp/executor
RUN useradd --create-home appuser
USER appuser
ENTRYPOINT ["python", "-m", "sci_console_executor.main"]
# Arguments (once|list, --tenant, ceilings, prices, ...) come from the job definition (Terraform), never from the image.
CMD ["--help"]
