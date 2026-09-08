# Domain API — activation request

One message, ready to send, plus the evidence behind it. Nothing here is
speculative: every technical statement was measured, and the questions are the
ones whose answers change what this platform may do with the data.

**Do not send this until the probe has established WHY the 403 happened.** The
status alone does not carry it: Domain documents a missing scope, a plan that
does not include the API, an environment restriction, an access restriction, an
invalid or expired key, and other internal denials as causes of the same 403 —
and they do not share an owner or a remedy.

Two readings decide which version of this message is correct, and both come
from the probe rather than from inference (audit §62.3):

| probe result | what to send |
| --- | --- |
| **Address Suggestion 200 + Suburb Performance 403**, with `X-Domain-Security-Reason` naming a scope, package or plan | the message below, **as written** — the key works, and the ask is the smallest activation that discharges that exact reason |
| **Both 403** | **do not send the message below.** Quote Domain's stated reason verbatim and ask them to confirm the project or access restriction it names. Both-403 is ambiguous — it is equally consistent with a project configuration, a missing scope, an environment or plan restriction, the key's own state, and a WAF refusal that never reached Domain's gateway |
| **Both 401** | not a commercial matter yet — an authentication or key question for the operator |

An earlier version of this document said that both-403 meant "the key holds no
packages" and to broaden the ask accordingly. That was a conclusion drawn from a
status code, and it is removed: it would have opened a larger commercial
conversation than the evidence supports, on a premise nobody had established.

**Do not discuss pricing in this message.** It is a scope and rights request.

---

## The message

> Subject: API package activation — Suburb Performance access for an existing key
>
> Hello,
>
> We hold an active Domain API key and are building suburb-level market analysis
> for Australian residential property. Our key currently returns HTTP 403 on
> `GET /v2/suburbPerformanceStatistics/{state}/{suburb}/{postcode}`, which we
> read as the required package not being attached to our project.
>
> Could you please:
>
> **1. Confirm and activate access.** Our key already succeeds against Address
> Suggestion (`api_properties_read`), so the application itself is working.
> Please confirm whether that same key/application can be granted the
> **`api_suburbperformance_read`** scope — via the **Properties & Locations**
> package or whatever the smallest applicable activation is — or whether a new
> application is required.
>
> *(Insert Domain's own `X-Domain-Security-Reason` here verbatim if one was
> returned — it names the restriction and saves a round trip.)*
>
> **2. Confirm what the Suburb Performance response contains**, specifically:
> - median sale price by period at suburb grain;
> - **house and unit reported separately**;
> - how many historical periods are returned, and the maximum available depth;
> - the **transaction/sample count** behind each period, if supplied;
> - the period type (monthly / quarterly / rolling 12 months) and the as-at date.
>
> We need enough history to compute a 1-year movement and 3- and 5-year compound
> growth. We calculate those ourselves from your observations — we are not asking
> you to supply pre-computed growth rates.
>
> **3. Tell us which demand measures are available at suburb grain** on this or a
> related package — for example days on market, auction clearance rate, vendor
> discount, listing or stock counts, sales volumes, or median advertised rent. We
> would rather use fewer measures we can rely on than a wider set we cannot.
>
> **4. Confirm the following usage rights in writing**, as they determine what we
> may build:
> - **Caching** — the maximum period we may retain a response;
> - **Derived metrics** — whether we may compute and store values derived from
>   your data (for example a growth rate or an internal score);
> - **Persistence** — whether we may retain observations as a historical record
>   beyond the cache window;
> - **Client-facing display** — whether figures, or metrics derived from them, may
>   appear in a report or PDF supplied to our clients;
> - **Attribution** — the exact wording and placement you require where they do.
>
> **5. Rate limits and quota** for the plan attached to this package, and whether
> the limits are per key or per account.
>
> For scale: our first extraction is approximately **245 requests** covering 637
> properties across 225 suburbs, and ongoing use is a similar order per refresh.
>
> Thank you,
> Aurixa / NPC Services

---

## Why each question is asked

| # | question | what the answer decides here |
| --- | --- | --- |
| 1 | package + scope on the existing key | whether this is a switch-on or a new application |
| 2 | series shape, dwelling split, depth, sample | `growth1Year`, `growth3YearCagr`, `growth5YearCagr` need ≥ 5 years; a blended house/unit median serves neither; `sampleSize` is 0.20–0.25 of every confidence reading |
| 3 | which demand measures exist | Demand components with no evidence stay **absent** — never zero, never 50 |
| 4 | caching / derived / persistence / display / attribution | `EvidencePoint.licensingStatus` defaults to `unverified`, and `mayReachClientReport` admits only `open` and `licensed_for_client_reports`. Until these are answered in writing a Domain figure may be scored in a shadow backtest and **may not** be rendered to a client |
| 5 | rate limits, per key or per account | this platform forwards the prime's keys to every clone, so a per-key limit is a fleet-wide ceiling |

## What is deliberately not asked

No pricing. No products beyond what Growth and Demand need — Domain publishes
several packages this programme has no use for, and asking for them invites a
larger conversation than the evidence requires. And no request for pre-computed
growth figures: Aurixa owns that arithmetic
(`growth/growthPeriods.pure.ts`), which is what lets a report show its working
rather than assert a number.
