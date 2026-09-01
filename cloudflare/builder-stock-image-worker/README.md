# Builder Stock image worker (Cloudflare Worker + Workers AI)

One private service, two endpoints, and neither of them decides anything.
Orchestration, validation, storage and serving all stay on the Supabase side —
this worker searches for nothing and stores nothing.

**`POST /v1/inpaint`** is the third stage of Builder Stock's image-cleaning
order: masked overlay inpainting, reached only when a property has **no clean
builder-supplied original** and the **deterministic repair could not safely
complete**. Two inputs (that property's own image patch and its approved
overlay mask), one output (the repaired PNG).

**`POST /v1/classify`** says what a picture SHOWS — a house from the street, a
floor plan, a wordmark, a page of text — for up to six pictures taken out of
one builder document. It ranks nothing, sees no property, no lot and no label,
and its whole vocabulary is a closed list the source declares. Exactly one
member, `shows_house_exterior`, can promote a picture; every other member can
only demote, and a batch it cannot answer leaves the caller exactly where it
was.

Everything about them — the calling contracts, the pinned models
(`@cf/runwayml/stable-diffusion-v1-5-inpainting` and
`@cf/meta/llama-4-scout-17b-16e-instruct`), the pinned prompts, the safety
fences, failure behaviour and the deployment steps — is documented in
[`docs/builder-stock/IMAGE_WORKER.md`](../../docs/builder-stock/IMAGE_WORKER.md).
Read that before touching `src/index.ts` or `wrangler.jsonc`.

Tests live with the rest of the Builder Stock suite so one runner covers both
sides of the wire:

```sh
npx vitest run src/lib/__tests__/builderStockCloudflareWorker.test.ts
```

Deploy (needs explicit approval; nothing has been deployed):

```sh
cd cloudflare/builder-stock-image-worker
npx wrangler deploy
npx wrangler secret put BUILDER_STOCK_IMAGE_WORKER_TOKEN   # long random string
```

Then set the same token and the printed workers.dev URL as the Supabase Edge
Function secrets `BUILDER_STOCK_IMAGE_WORKER_TOKEN` /
`BUILDER_STOCK_IMAGE_WORKER_URL`. Until both exist, the generative route
reports `inpaint_unavailable` and stays retryable while everything else works.

## Rate limiting — REQUIRES EXTERNAL CONFIGURATION

The worker itself now bounds what any one request can cost (declared-length
ceiling, square-patch pin, mask ink ceiling, pinned `num_steps`), but nothing
in this repository bounds how often an authenticated caller may ask. Workers
Rate Limiting is a wrangler binding (GA since 2025-09-19) — no KV, no Durable
Object — but `wrangler` is not a dependency of this repository (deploys run
`npx wrangler deploy`, resolving whatever version npx finds that day), so the
binding's exact configuration key must be verified against the wrangler
version actually used at deploy time rather than committed here untested.
When enabling it:

1. Add to `wrangler.jsonc` (verify the key shape against `wrangler --version`):
   `"ratelimits": [{ "name": "LIMITER", "namespace_id": "1001", "simple": { "limit": 30, "period": 60 } }]`
2. In `src/index.ts`, guard so an undeployed binding changes nothing:
   `if (env.LIMITER) { const { success } = await env.LIMITER.limit({ key: 'inpaint' }); if (!success) return json(429, 'rate limited'); }`
3. Note the binding is best-effort and per-colo — an abuse damper, not a
   quota. Account-level WAF rate rules on the workers.dev route are the
   dashboard-side alternative.

Neither step is deployed by this repository; deployment of this worker
requires explicit approval (see above).
