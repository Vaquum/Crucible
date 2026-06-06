FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md /app/
COPY src /app/src

RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir .

ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA

EXPOSE 8877

CMD ["python", "-m", "crucible"]
