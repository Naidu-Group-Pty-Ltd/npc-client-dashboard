# Who owns the Airtable key

Two different things on this platform talk to Airtable, and until 6 Sep 2026
they shared one secret name by accident.

## The Listings & Overview pipeline

`airtable-proxy`, `listings-cache`, `listing-images` and `listing-enrichment`
read the **Property Intake Master** table through six environment names:

| Name | What it is |
|---|---|
| `AIRTABLE_TOKEN` | The personal access token the pipeline reads with |
| `AIRTABLE_BASE_ID` | The `NPC Emails` base |
| `AIRTABLE_TABLE_NAME` | The intake table (an id in this deployment) |
| `AIRTABLE_TABLE_ALLOWLIST` | The tables `airtable-proxy` may serve |
| `AIRTABLE_TABLE_ALIASES` | Alias overrides for table names |
| `AIRTABLE_IMAGE_LIBRARY_FIELD` | The attachment field `listing-images` harvests |

By the owner's decision these are **one value across the prime and every
clone**: every deployment reads the same intake. Mission Control holds the
values, forwards them at provisioning and on request (`prime_secret_forwards`
carries all six as `inherit = true`), and its clone-secrets sweep keeps them.
Nothing on a deployment's own pages sets them.

The names live once, in `supabase/functions/_shared/listingsPipelineSecrets.pure.ts`.

## The Integrations page's Airtable card

The card on `/integrations` collected an "API Key" as `AIRTABLE_API_KEY` and a
"Base ID" as `AIRTABLE_BASE_ID`, and `SUPABASE_SECRET_ALIASES` mapped the first
onto `AIRTABLE_TOKEN` before `update-integration-secret` wrote both into the
project's environment through the Management API. So a key typed on that page
**superseded the pipeline's key** on whichever deployment it was typed on, and
a base id typed there re-pointed the pipeline at another base. Nothing failed
loudly; the Listings page simply read somebody else's Airtable, or nothing.

The card is the **workflow connection** now — what the Workflow Playground's
Airtable operations (`airtable.list_records`, `create_record`,
`update_record`) authenticate with — under its own names:

| Field | Secret |
|---|---|
| API key (workflows) | `AIRTABLE_API_KEY` |
| Base ID (workflows) | `AIRTABLE_WORKFLOW_BASE_ID` |

The alias is gone, the generated allow-list no longer contains any pipeline
name (so the endpoint cannot be asked for one by a hand-built request either),
and `update-integration-secret` refuses the six pipeline names **before** the
allow-list check with a message that names the rule, because "not in
allowlist" reads as a typo and this is a decision.

## Three rules

1. **A pipeline name is never written from a deployment's own pages.** If the
   value has to change, it changes on Mission Control and travels.
2. **The workflow connection and the pipeline are different credentials with
   different names**, even where an operator would use the same Airtable
   account for both. Sharing a name is how one page came to overwrite the other.
3. **The list is the contract.** `listingsPipelineSecrets.test.ts` reads the
   four pipeline functions and fails if any of them reads an `AIRTABLE_*` name
   the list does not carry, or if any Integrations field resolves to one it does.
