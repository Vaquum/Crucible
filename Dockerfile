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

# Fail the BUILD, not production, when the unpinned (Limen @ main) klines
# source cannot be imported. A missing transitive dep — like pyarrow, which
# Limen imports but does not declare — would otherwise only surface as a
# crash-looping container after deploy. This line is why a runtime image that
# cannot load its klines source can never ship.
RUN python -c "from limen import HistoricalData"

ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
ARG BUILD_DATE=""
ENV BUILD_DATE=$BUILD_DATE
ARG GIT_SUBJECT=""
ENV GIT_SUBJECT=$GIT_SUBJECT

EXPOSE 8877

CMD ["python", "-m", "crucible"]
