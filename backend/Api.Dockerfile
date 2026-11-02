FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY api-requirements.txt ./
RUN pip install --no-cache-dir -r api-requirements.txt
COPY menu_api ./menu_api
USER 10001:10001
ENTRYPOINT ["uvicorn", "menu_api.app:app", "--host", "127.0.0.1", "--port", "8088", "--workers", "1", "--no-access-log"]
