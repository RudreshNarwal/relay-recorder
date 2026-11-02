FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ASR_MODEL_DIR=/models
WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home --uid 10001 relay && mkdir /models && chown relay /models
COPY app.py ./app.py
USER relay
EXPOSE 8100
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100", "--workers", "1", "--limit-concurrency", "4", "--timeout-keep-alive", "5"]
