FROM python:3.12-slim

WORKDIR /app

# Nur requirements zuerst -> besseres Layer-Caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p /app/data

EXPOSE 8000

# 1 Worker (aktive DB + Schlüssel leben im Prozess), Threads für Nebenläufigkeit.
CMD ["gunicorn", "-w", "1", "--threads", "4", "-b", "0.0.0.0:8000", "app:app"]
