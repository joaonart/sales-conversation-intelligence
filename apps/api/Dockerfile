FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app
COPY apps/api/pyproject.toml ./pyproject.toml
COPY apps/api/src ./src
RUN pip install --no-cache-dir .
RUN useradd --create-home appuser
USER appuser
CMD ["uvicorn", "sci_api.main:app", "--host", "0.0.0.0", "--port", "8080"]
