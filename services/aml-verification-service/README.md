# AML verification service

Face match, liveness signal and MRZ validation for the zero-cost KYC stack
(`docs/aml/kyc-zero-cost-solution.md`).

**Stateless by design.** It accepts images, returns numbers, and keeps nothing.
The record of truth for a retained biometric is the Supabase `aml-biometrics`
bucket, whose every read is written to `aml.biometric_access_log`. If this
service also persisted images it would become a second, unaudited copy of the
most sensitive data in the system. A test (`tests/test_api.py`) asserts the
source contains no persistence calls.

It also makes **no decision**. It returns scores and thresholds; the edge
function records the outcome, and only a human moves the service gate.

## Licensing — read before changing a model

Both models are Apache-2.0 **including their weights**, which is the entire
reason this stack is free and lawful:

| Model | File | Licence |
|---|---|---|
| SFace (recognition) | `face_recognition_sface_2021dec.onnx` | Apache-2.0 — SIAT |
| YuNet (detection) | `face_detection_yunet_2023mar.onnx` | Apache-2.0 |

**Do not substitute InsightFace / ArcFace weights** (including indirectly, via
CompreFace or DeepFace defaults). Those are licensed for non-commercial
research only and would make this deployment a licence breach. The permissive
badge on a repository says nothing about the weights it downloads at runtime —
verify the weights.

See `NOTICE` for the attribution Apache-2.0 requires you to retain.

## Run

```sh
export AML_SERVICE_TOKEN="$(openssl rand -hex 32)"
docker compose up --build
```

Models are fetched at **build** time, so the image is self-contained and the
service cannot start against a half-populated model directory.

```sh
curl -s localhost:8080/healthz | jq
```

## Endpoints

All require `Authorization: Bearer $AML_SERVICE_TOKEN`. The service **fails
closed** if the token is unset — an unauthenticated verification service would
let anyone submit faces for comparison.

### `POST /face/compare`
`{ document_image, selfie_image }` (base64) →
```json
{ "verdict": "match|review|no_match|unusable", "similarity": 0.41,
  "thresholds": { "match": 0.363, "review": 0.28 }, "quality": {...} }
```
`review` is a first-class outcome, not a rounding of `no_match` — a borderline
score is exactly the case a human should see. `unusable` means the **capture**
failed (no face, too small), not the identity; the caller must not spend one of
the customer's three attempts on it.

### `POST /face/liveness`
`{ selfie_image }` → `{ is_real, score, signals, confidence: "low", advisory }`

**A signal, not a verdict.** Sharpness and screen-replay heuristics only. It
will catch a photo of a screen or an obviously flat print. It will **not**
reliably catch a high-quality print attack, a mask, or an injected deepfake.
The limitation is returned in every response so a caller cannot be misled by
reading only the boolean.

### `POST /doc/mrz`
`{ document_image }` → `{ found, valid, format, fields, checks, errors }`

A failed check digit is the strongest free forgery signal available. An
unreadable MRZ returns `found: false` and is **not** a failure — most
Australian driver licences carry no ICAO MRZ at all.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `AML_SERVICE_TOKEN` | — | **Required.** Service fails closed without it. |
| `AML_FACE_MATCH_THRESHOLD` | `0.363` | OpenCV's reference cosine threshold for SFace |
| `AML_FACE_REVIEW_THRESHOLD` | `0.28` | Below match, above this → human review |
| `AML_MIN_FACE_PX` | `60` | Smaller faces give unreliable embeddings |
| `AML_MAX_IMAGE_BYTES` | `8388608` | |
| `AML_MODEL_DIR` | `/models` | |

The edge function reaches this service via `AML_VERIFICATION_SERVICE_URL` and
`AML_VERIFICATION_SERVICE_TOKEN`. If either is unset the provider throws rather
than degrading — a misconfigured service must never look like a customer who
failed verification.

## Tests

```sh
pip install -r requirements-dev.txt
python -m pytest tests/ -q
```

Runs without the ONNX models present. The MRZ check-digit expectations are
duplicated in `src/lib/aml/screeningMatch.test.ts` on purpose: the two
implementations must agree, and a divergence should break a test rather than
quietly produce different verdicts on the two sides of the wire.

## Deployment notes

- Runs unprivileged (`uid 10001`), `read_only` root filesystem, `no-new-privileges`.
- Bind to loopback and reach it over a private network or tunnel. It handles
  biometric data and has no business being publicly routable.
- No volumes. Nothing is persisted.
- The port is `8080` unless `$PORT` names another one. Nothing else in the
  service reads it; the host does.

### On Vercel

The repository's `vercel.json` declares this directory as a service. It is built
as a **container** — `"runtime": "container"`, `"entrypoint": "Dockerfile"` —
and deliberately not with Vercel's Python/FastAPI runtime, which is what its
framework detection reaches for on its own.

That runtime installs `requirements.txt` and nothing else. `tesseract` is a
system package, so `/doc/mrz` would have no binary to call, and the ONNX weights
are fetched by `scripts/fetch_models.sh` at **image build** time, so `/models`
would be empty and both face endpoints would raise `ModelUnavailable`. The
service would boot, answer, and report `degraded` — which is the state the
go-live runbook (`docs/aml/kyc-go-live-runbook.md`) requires you to keep the IDV
provider inactive through. Giving the Python runtime the entrypoint it asks for
buys a build that succeeds and a service that cannot verify anybody.

Two things the deployment needs that are not in this repository:

- **`PORT=8080` in the project's environment variables.** Vercel routes to port
  `80` by default, and this container cannot bind it — it runs unprivileged.
- **The `AML_SERVICE_TOKEN` secret.** On Vercel the `/api/*` route is public
  (the Supabase Edge Functions call it from outside Vercel's network), so the
  shared secret is the whole of the access control. The service failing closed
  without it is what keeps an unconfigured deployment from being an open face
  comparison endpoint.

Public requests arrive as `/api/face/compare`; a `request.path` transform in the
service's own `routes` strips the prefix, so the container still sees
`/face/compare`, `/doc/mrz`, `/face/liveness` and `/healthz`. Those paths are
the service's contract with the Edge Function and with `docker compose` — do not
move them into the app to suit one host's URL layout.

One thing to weigh rather than assume: a container function scales to zero after
five idle minutes, so the first request after a quiet spell pays for loading
SFace and YuNet. The runbook asks for a persistent container, and scale-to-zero
compute is not one.
