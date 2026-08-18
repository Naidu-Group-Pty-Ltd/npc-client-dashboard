# NPC Client Dashboard

The **client-facing deployment** of the NPC Property Dashboard. This
repository is a mirror of
[`npc-property-dashbord`](https://github.com/lavan96/npc-property-dashbord)
that builds with the client-facing mode pinned on, so the developer/operator
tooling — the Integrations credential cards, Workflow Playground, engine
diagnostics, test-data controls such as the Call Logs test numbers — is hidden
from navigation and routing.

Two things to hold onto:

- **The mode is presentation, not access control.** Module permissions,
  workspace entitlements and the edge functions' own auth checks are untouched.
  Hiding the Integrations page does not disturb the Make.com → Airtable
  **Property Intake Master** intake pipeline — that runs server-side and never
  depended on the UI being visible.
- **This repo carries (almost) no code of its own.** Features and fixes land in
  `npc-property-dashbord` first and are pulled over. The only deliberate
  divergence is the pin in `vite.config.ts`
  (`process.env.VITE_CLIENT_FACING ??= "true"`) and this README.

The full design — the one hidden-path list, the route gate, the page-level
gates, what is deliberately *not* hidden — is in
[`docs/CLIENT_FACING_MODE.md`](./docs/CLIENT_FACING_MODE.md), and the
mechanism lives in [`src/lib/clientFacing.ts`](./src/lib/clientFacing.ts).

## Building

```sh
npm install
npm run build      # client-facing bundle — the flag is pinned in vite.config.ts
```

Environment setup is the same as upstream (see `.env.example`). An explicitly
exported `VITE_CLIENT_FACING=false` overrides the pin if an internal-console
bundle is ever needed from this repo.

## Syncing from upstream

```sh
git remote add upstream https://github.com/lavan96/npc-property-dashbord   # once
git fetch upstream
git merge upstream/main
```

The pin sits in `vite.config.ts`, so merges stay clean unless upstream edits
the top of that file or this README.

## GitHub Actions

The mirrored workflows (`.github/workflows/`) deploy Supabase functions and
Cloud Run services using per-repository secrets and federation that are
configured for the upstream repository only. Leave Actions disabled here (or
leave the workflows unconfigured) — this repository exists to build and host
the client-facing front-end, not to run the deploy pipeline twice.
