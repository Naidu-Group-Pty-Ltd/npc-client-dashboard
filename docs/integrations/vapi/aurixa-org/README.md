# Aurixa Systems org — live inbound prompts

Org `453f00c2-cb26-43f0-8da3-2eb13b578e15`. This is **where the live NPC line
answers**, and it is not the org the sibling directories capture:
[`snapshot/`](../snapshot) and [`npc-services/`](../npc-services) are the
*source* org `c9015cd5-…`, taken before the migration.

Only the assistants changed by
[`TRANSFER_TO_HUMAN.md`](../TRANSFER_TO_HUMAN.md) are here. This is not an org
snapshot and does not try to be one.

| file | assistant | id | MD5 of the live prompt |
|---|---|---|---|
| `prompts/npc-inbound-agent.b834610e.md` | NPC Inbound Agent (Angela) | `b834610e-469e-4f9f-9130-01a1fa751064` | `f24069d0eb68752fc38166e93aa58a7c` |
| `prompts/npc-ifc-inbound.ed0aa90f.md` | NPC IFC Inbound | `ed0aa90f-e5ea-439d-b086-f694cf5f978d` | `764c54fa5b7a7b32645373b738d3d8c3` |
| `prompts/npc-strategy-session-inbound.f958ec93.md` | NPC Strategy Session Inbound | `f958ec93-6f41-4507-a7b1-f8c8d54e775e` | `0db3dc62dfbc616b25634976128fc2c6` |

Each file is the `model.messages[0].content` string exactly as Vapi returned it
after the change, byte for byte. The MD5 above is what a `GET /assistant/<id>`
computes over that field today; it is how you tell whether the live prompt has
drifted from this record.

## What this is for

**It is the rollback.** The *previous* text of all three is already in git — they
were byte-identical to their `snapshot/` copies before the edit, verified by
length and MD5 — so a revert is a `PATCH` back to the snapshot's string. There
was no forward record until this directory existed.

## Three things to know before editing a prompt here

**Vapi `PATCH` replaces a whole top-level key.** Changing the prompt means
sending the entire `model` object — `provider`, `model`, `toolIds`,
`knowledgeBase` and `messages` together. Sending `messages` alone drops the tool
bindings and the knowledge base, silently, and the assistant keeps answering.

**The knowledge-base file id differs between orgs.** It is
`1e87753e-6c9e-427f-8e72-95c24c0dcea6` here and `9fff4149-…` in `snapshot/`.
Read it live; do not copy it from the source-org capture.

**A Make mapper resolves `{{firstName}}`.** These prompts contain five such
tokens, in the very sentences instructing the assistant never to say a raw
variable aloud. Anything that carries a prompt through Make must not expose it
as a mapper literal, or those five are silently replaced with nothing.
