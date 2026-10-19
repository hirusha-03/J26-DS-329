# Use official lightweight Python image
FROM python:3.11-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Set work directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY requirements.txt requirements-explain.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Opt in with --build-arg WITH_EXPLANATIONS=true. Mount checksum-pinned best.pt
# read-only at runtime; no checkpoint release is published yet.
ARG WITH_EXPLANATIONS=false
RUN if [ "$WITH_EXPLANATIONS" = "true" ]; then pip install --no-cache-dir -r requirements-explain.txt; fi

# Copy project
COPY . .

# M1 disease model from its GitHub Release (checksum-verified; weights are not in git)
RUN python scripts/fetch_model.py

# Expose port
EXPOSE 8000

# Start app
CMD uvicorn app.main:app --host 0.0.0.0 --port $PORT
