# Turnstile on the login pages

Five login pages render the same widget — staff (`/auth`), client portal, finance
portal, solicitor portal and builder portal — through
`src/components/auth/TurnstileWidget.tsx`. The Sign In button on each is disabled
until that widget produces a token. **So a Turnstile that will not issue a token
is a login page that cannot be used**, and every failure of this component is an
outage of the product's front door.

That is the reason for everything below.

## The defect this replaced

The widget asked Cloudflare for a challenge and, when Cloudflare refused, threw
the reason away:

```ts
'error-callback': () => { setUnavailable(true); onErrorRef.current?.(); }
```

Cloudflare passes the error code as that callback's first argument — its
shipping `api.js` calls it as `cbError(String(code))` — and all eleven
documented codes rendered one sentence:

> The security check could not load, so sign-in is unavailable. Check your
> connection, or any ad/script blocker for **challenges.cloudflare.com**.

That sentence is correct for exactly one code (`200500`, the challenge iframe was
blocked). For `110200` it is false in both halves: the script loaded perfectly,
and no ad blocker is involved — Cloudflare refused the **hostname**. Beside it sat
a "Retry security check" button, which for that class of failure can only ever
fail the same way, for ever.

A visitor who cannot sign in, an operator reading "check your ad blocker", and a
bug report that says "there's a Turnstile error on the auth pages" are all the
same defect: **the one fact that identifies the fault was discarded at the only
point it was ever available.**

Now the code is classified (`src/lib/security/turnstile.ts`), printed on the page
beside the hostname, and logged to the console:

```
[Turnstile] 110200 on npc-client-dashboard-abc123-team.vercel.app (sitekey 0x4AAA…) — Add …
```

## Reading the code

Cloudflare's table
([client-side error codes](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/))
is the authority; `classifyTurnstileFault` mirrors it and nothing else. An
undocumented code resolves to `unknown` and is still displayed verbatim, because
guessing an owner for a code we cannot read is how somebody ends up applying the
wrong remedy.

| Code | Means | Who fixes it |
|---|---|---|
| `110200` | Hostname not authorised for this widget | **Operator** — Hostname Management (below) |
| `110100`, `110110`, `400020` | Sitekey invalid or not found | **Operator** — wrong/typo'd key |
| `400070` | Sitekey disabled | **Operator** — re-enable the widget |
| `200500` | Challenge iframe blocked | Visitor — ad/script blocker, network |
| `110600`, `110620` | Challenge or interaction timed out | Visitor — retry; check the clock |
| `200100` | Clock or cached challenge | Visitor — correct the device clock |
| `300***`, `600***` | Generic challenge failure | Visitor — retry |
| *no code* | The script never arrived | Visitor — blocked or offline |

The retry button is offered only where retrying can succeed. The three operator
classes are terminal by Cloudflare's own definition.

## Hostname Management is the whole of the 110200 fix

Turnstile matches the hostname the page is served from against the widget's list.
Two rules decide everything:

- a listed hostname covers **that hostname and its subdomains**;
- **wildcards are not accepted** (`*.example.com` is not a valid entry).

Which means a per-deployment hostname can never be allow-listed.
`npc-client-dashboard-<hash>-<team>.vercel.app` is a *sibling* of
`npc-client-dashboard-<team>.vercel.app`, not a subdomain of it, and each
deployment invents a new one. A widget keyed to the production hostname will
refuse every preview URL with `110200`, permanently.

So there are three supported arrangements, and the deployment picks one:

1. **Production hostname on the prime's widget.** Add
   `command-centre.npcservices.com.au` (or the zone apex, which covers every
   subdomain) in *Cloudflare dashboard → Turnstile → the widget → Hostname
   Management*. Nothing in the repository changes.
2. **A second widget for a second deployment.** Create a widget listing that
   deployment's hostnames and set `VITE_TURNSTILE_SITE_KEY` for that build only.
   Its `TURNSTILE_SECRET_KEY` must be set to the **same widget's** secret in that
   deployment's Supabase function secrets — the two halves are a pair, and a
   mismatch passes the widget and then fails siteverify, which looks like a
   password problem rather than a configuration one.
3. **Cloudflare's test sitekey for previews.** `1x00000000000000000000AA` always
   passes and is accepted on any hostname. It is a deliberate decision to accept
   no bot protection on that deployment, and it belongs only where the
   deployment is already access-controlled (Vercel preview SSO, for example) —
   never on anything a client reaches.

## The sitekey is configuration, not a literal

It was `const TURNSTILE_SITE_KEY = '0x4AAAAAAChQyb0ZxBORhxWq'` in the component,
so option 2 above did not exist: pointing a build at a different widget required
a code change. It now resolves through `resolveTurnstileSiteKey`, and the prime's
key remains the fallback — a build that sets nothing behaves exactly as it always
has, which is what makes this safe to land everywhere at once.

The pattern (and the reasoning) is `src/integrations/supabase/env.ts`.

## What the server does with the token

`verifyTurnstile` in `supabase/functions/_shared/publicAbuseControls.ts` posts the
token to siteverify with `TURNSTILE_SECRET_KEY`. Note the asymmetry, because it
decides what an outage looks like:

- **the server fails open** unless `REQUIRE_TURNSTILE=true` — no secret, or no
  token, and the login proceeds;
- **the client fails closed** — no token, no Sign In button.

So a widget that cannot render takes the login page down even where the server
would have accepted the request. That is deliberate (a challenge that silently
stops being enforced is worse than a visible failure), but it is why a Cloudflare
configuration error presents as a total outage rather than as degraded
protection, and why the code on the page matters so much.

Related: `src/lib/security/requestSchemas.spec.ts` records WP-27, where four of
the five logins rejected every sign-in with `400 invalid_body` because
`turnstile_token` was sent as `null` and the schema only admitted `undefined`.
Same front door, different half of the same field.

## Tests

- `src/lib/security/turnstile.test.ts` — every documented code maps to the
  documented owner and retryability; the blocked-script sentence appears for
  `200500` and nothing else; an undocumented code keeps its value; the sitekey
  falls back when unset.
- `src/components/auth/TurnstileWidget.test.tsx` — the code reaches the page, the
  hostname is named for `110200`, no retry button is offered for a terminal
  fault, and one console line is logged per code (Cloudflare re-fires
  `error-callback` on its own retry schedule).

Both fail if `error-callback` goes back to ignoring its argument.
