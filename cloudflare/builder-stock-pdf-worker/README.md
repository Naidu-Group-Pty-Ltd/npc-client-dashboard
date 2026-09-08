# Builder Stock PDF election worker

Runs the shared `electFromPdfBytes` where there is CPU for it. It decides
nothing about a property.

## Why it exists

Per-execution platform telemetry, 8 September 2026 — a thirteen-property cold
start of the Builder Stock settler:

| reason | n | max memory | max `cpu_time_used` |
|---|---|---|---|
| `EarlyDrop` (normal) | 48 | 72 MB | 1828 |
| **`CPUTime` (killed)** | **13** | **108 MB** | **2776** |

**Every kill was CPU.** Memory peaked at 108 MB of 256 — 42%. Reading one heavy
brochure and electing its image is indivisible and costs about 2.4 s against an
Edge Function's 2,000 ms ceiling. It does not fit, and no scheduling rule makes
it fit. So that one unit runs here and nothing else moves.

## What crosses the boundary

**Request** — `POST /v1/elect`, `Authorization: Bearer <token>`

- body: the PDF, raw. Base64 of a 14 MB brochure is ~19 MB and real CPU spent
  in exactly the isolate that has none to spare.
- `x-election-context`: base64 UTF-8 JSON — `protocol`, `label`,
  `identifiedBy`, `design`, `identityHints`, `documentName`, `url`.

That is the whole of it. **No row id, no organisation id, no upload id, no
credential.** The worker is never told which property row it is looking at, so
it could not act on one even in principle.

**Response** — `200` with `{ protocol, status, image?, detail? }`, where
`status` is the election's own `recovered` / `not_identified` / `unreachable`
and `image` carries `bytes` (base64), `contentType`, `reference`, `provenance`
and `role`.

`401` unauthorised · `400` bad context · `413` bad document · `503` no token
configured · `404` anything else.

## What it is not allowed to do

No database client, no Supabase key, no service-role key, no storage
credential, no storage write, no property mutation. `wrangler.jsonc` declares
**no bindings at all** — one bearer secret is its entire configuration.
Everything that persists — the image, provenance, work stage, settlement,
availability — stays in the Supabase path exactly where it already is.

This mirrors `builder-stock-image-worker`: narrowly scoped Cloudflare compute,
with Supabase authoritative for orchestration and storage.

## Failure is always operational

Unreachable, refused, timed out, killed by Cloudflare for CPU or memory, or
answering something that is not a result — every one of those reads as
`unreachable` on the Supabase side, which records nothing and retries.
`not_identified` is a *verdict*: it is banked, and it suppresses that source
until a version bump. `pdfElectionClient.ts` is written so it cannot construct
that value at all; the only way it reaches a caller is relayed from a worker
that actually read the document.

**And there is no in-process fallback under the worker runtime.** Falling back
would re-run the thing measured to die and re-create the exact `CPUTime`
failure this exists to fix. See `pdfElectionRoute.pure.ts`.

## Deploying (nothing has been deployed)

```sh
npx wrangler deploy -c cloudflare/builder-stock-pdf-worker/wrangler.jsonc
npx wrangler secret put BUILDER_STOCK_PDF_WORKER_TOKEN \
  -c cloudflare/builder-stock-pdf-worker/wrangler.jsonc   # long random string
```

Then set the same pair on the Supabase project — `BUILDER_STOCK_PDF_WORKER_URL`
and `BUILDER_STOCK_PDF_WORKER_TOKEN` — and only then advance
`RUNTIME_VERSION` to 3. Until that bump every route resolves in process and
production behaves exactly as it does today.

**Workers Paid is required.** CPU time per request is 10 ms on Workers Free and
30 s on Paid; the election needs ~1.2 s, so on a free account every run dies
`exceededCpu`.

## Validation

Excluded from `tsconfig.worker.json` — that gate is for
`builder-stock-image-worker`, whose premise is that it imports nothing, and
this one imports the shared election on purpose. It is validated instead by the
toolchains that actually compile it, in the `builder-stock-pdf-worker` CI job:
`deno check` over the entry and every shared module behind it, then `npm ci`
and the wrangler build that resolves the `esm.sh` → npm alias.
