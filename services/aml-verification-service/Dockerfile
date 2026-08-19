# Verification service — face match, liveness signal, MRZ.
# Stateless: no volumes for customer data, no database access.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AML_MODEL_DIR=/models

# libGL/libglib for OpenCV; tesseract for the MRZ read.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 tesseract-ocr curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY scripts ./scripts
COPY NOTICE ./NOTICE

# Models are fetched at build time so the image is self-contained and the
# service cannot start against a half-populated model directory.
RUN sh scripts/fetch_models.sh

# Run unprivileged. The service handles biometric data; it has no business
# running as root.
RUN useradd --system --uid 10001 amlsvc && chown -R amlsvc /srv /models
USER amlsvc

# The port is 8080 unless the host names another one in $PORT. Vercel routes to
# port 80 by default and expects `PORT` to say otherwise; a container that hard
# codes its port answers nothing there, and this one cannot fall back to 80
# because it runs unprivileged. Compose and a plain `docker run` set no PORT and
# so keep 8080, which is what the runbook and README document.
EXPOSE 8080
# Healthy means it can verify somebody, not merely that it answers. /healthz
# returns 200 while reporting `degraded`, so checking the status code alone
# would route traffic to a container whose models are unusable — the same
# mistake the probe itself used to make.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import json,os,urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8080') + '/healthz'); sys.exit(0 if r.status==200 and json.load(r).get('status')=='ok' else 1)"

# `exec` so uvicorn is PID 1 and receives SIGTERM itself: the shell would not
# forward it, and a scaled-down instance would be killed mid-request instead of
# draining.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"${PORT:-8080}\" --workers 2"]
