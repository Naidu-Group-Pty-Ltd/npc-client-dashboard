# "Can I speak to a human?" — why it never worked, and what it took

Angela is the entry assistant on NPC's inbound line. A caller who asked her
plainly for a person did not get one, on any call, ever. The `transfer_to_human`
tool was bound, its hook was live, the scenario behind it worked, and the whole
downstream chain had been proven by hand more than once. The only leg never
exercised was **Angela deciding to invoke it** — and when it was finally
exercised, it failed.

It failed for **two independent reasons, each sufficient on its own**, and the
second one only became visible once the first was fixed.

## Defect 1 — four places told her not to transfer

`transfer_to_human` has a 5,400-character protocol in Angela's prompt at
character 35,468: when to use it, when not to, a confirmation script, a failure
path, priority rules. It is thorough and it is correct.

Everything a model reads *before* it points the other way.

| where | what it said |
|---|---|
| **§0 Role Priority Summary** (char 171) | Five numbered duties. Transferring to a person is **not one of them**. This is the first thing in the prompt and it frames the rest. |
| **§8 When Caller Asks About Next Steps** (21,790) | Claims *"Can I speak to someone?"* as a next-steps signal and answers it with a scripted discovery-call explanation. |
| **§9 When Caller Wants a Human** (22,354) | Titled with the exact trigger. Tells her to ask *"are you looking for an initial discovery call, a strategy session, or something finance-related?"* and route to another **assistant**. Never mentions `transfer_to_human`. |
| **§15 Absolute Rules** (40,887) | ~60 bullets, none about transferring to a person. |

The one statement that resolves the conflict — *"If the caller explicitly
requests a human, this request overrides … additional qualification questions"* —
sits at character 39,257, **17,000 characters after §9**, and does not name §9.

Angela was the **only one of the fifteen NPC assistants carrying §9**, and she
is the squad's entry member. Every inbound caller met it.

**Fix:** §0 gains a sixth duty and an explicit precedence statement; §8 disowns
the phrase and points at §9; §9 is rewritten into 9.1 (asked for a person →
transfer), 9.2 (asked about a topic → route, keeping the original script
verbatim), 9.3 (genuinely ambiguous → one question, transfer offered first) and
9.4 (the three "do not promise" lines, unchanged); §15 gains three prohibitions
and one obligation.

**Nothing was removed.** The routing path, the qualifying question and every
safety rule survive word for word — §9.2 is the old §9, relocated behind the
test that decides which case it is.

## Defect 2 — the tool call waited for a turn that never comes

With Defect 1 fixed, the first live test produced this:

```
AI:   Hi there. Angela from NPC Services speaking. How can I help you today?
User: Hi there. Can I please speak to a human?
AI:   Absolutely. I'll try to get you through to someone from the team now.
```

That is the protocol's confirmation script, verbatim. Then nothing. No tool
call. `endedReason: silence-timed-out`. No leg to the mobile.

The cause is the protocol's own **Tool Invocation Rule**:

> After the spoken transfer confirmation, the assistant's next turn MUST be
> tool-only. In that next turn: call `transfer_to_human` …

In a voice loop the assistant gets another turn **only when the caller speaks**.
A caller who has just been told they are being put through has no reason to say
anything — so the tool call sits behind a turn that never arrives, and the line
goes quiet until it times out.

Four places in the prompt said it. All four now put the sentence and the tool
call in the **same turn**, and state the priority explicitly: the tool call is
the half that must never be missed.

That ordering is deliberate and was earned. The intermediate version said only
"same turn", and the model resolved it the other way — it placed the call and
skipped the sentence, transferring the caller in silence. Naming which half
matters more is what produced both.

## The ablation

Three live calls, same script (*"Hi there. Can I please speak to a human?"*),
judged on the Twilio leg to the escalation mobile rather than on the phone
sounding fine.

| version | said the sentence | called the tool | leg to the mobile |
|---|---|---|---|
| §9 fix only | yes | **no** — `silence-timed-out` | **none** |
| \+ same-turn rule | **no** | yes | yes, 13 s |
| \+ tool-call-is-the-half-that-matters | yes | yes | **yes** |

Corroborated independently by the Make context store, which recorded
`status: transfer_requested` against the third call, and by the Vapi record,
whose message roles end on a third `tool_calls` with no result — the SIP leg was
torn down by the redirect before the result could be written.

## Two rules worth keeping

**A prompt is read top to bottom, and the nearest instruction wins.** A correct
protocol 13,000 characters below a wrong section is not a correction; it is a
second opinion the model has already stopped asking for. Where two passages
address one situation, the earlier one must defer explicitly, by name.

**An instruction that depends on a turn is a promise about the caller.** "Do X
on your next turn" quietly assumes the caller will speak again. Whenever the
instruction follows something that makes speaking pointless — a transfer, a
goodbye, a hold — that assumption is false and the instruction never runs.

## Scope

Fixed in the Aurixa Systems org (`453f00c2-cb26-43f0-8da3-2eb13b578e15`), which
is where the live line answers:

| assistant | id | what was fixed |
|---|---|---|
| NPC Inbound Agent (Angela) | `b834610e` | defects 1 and 2 |
| NPC IFC Inbound | `ed0aa90f` | defect 2 |
| NPC Strategy Session Inbound | `f958ec93` | defect 2 |

The latter two are squad members a caller reaches **after** Angela routes them,
so the same request to them hit the same wall. Their prompts were byte-identical
to their snapshots before the change, and their fix is the identical rule edit;
their behaviour is asserted from the ablation above rather than re-tested per
assistant.

**Still carrying defect 2 and not fixed:** `NPC Discovery Call No Show Follow
Up`. It is an outbound follow-up assistant, not on the inbound path, and
changing it was outside what was asked.

Every change was a `PATCH` of the whole `model` object — Vapi replaces a
top-level key wholesale, so `toolIds`, `knowledgeBase`, provider and model were
re-sent with it and verified on read-back, along with the resulting prompt's
length and MD5 against a locally composed target.

The prompts as they now stand are in [`aurixa-org/`](./aurixa-org), which is the
rollback artefact.
