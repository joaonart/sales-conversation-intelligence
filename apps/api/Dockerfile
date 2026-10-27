# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app
COPY packages/evaluation-core /tmp/core
COPY apps/api /tmp/api
RUN pip install --no-cache-dir /tmp/core /tmp/api && rm -rf /tmp/core /tmp/api
RUN useradd --create-home appuser
USER appuser
CMD ["uvicorn", "sci_api.main:app", "--host", "0.0.0.0", "--port", "8080"]
