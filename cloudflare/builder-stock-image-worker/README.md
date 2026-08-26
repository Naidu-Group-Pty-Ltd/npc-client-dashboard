# Builder Stock image worker (Cloudflare Worker + Workers AI)

The third stage of Builder Stock's image-cleaning order: masked overlay
inpainting, reached only when a property has **no clean builder-supplied
original** and the **deterministic repair could not safely complete**. One
endpoint (`POST /v1/inpaint`), two inputs (that property's own image patch and
its approved overlay mask), one output (the repaired PNG). Orchestration,
validation, storage and serving all stay on the Supabase side — this worker
searches for nothing and stores nothing.

Everything about it — the calling contract, the pinned model
(`@cf/runwayml/stable-diffusion-v1-5-inpainting`), the pinned prompt, the
safety fences, failure behaviour and the deployment steps — is documented in
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
