/**
 * Stage 6's working surface: what the customer declared, what has been
 * recorded, what is verified — and what the Aurixa Passport makes of it.
 *
 * ── The gap this closes ───────────────────────────────────────────────
 * The customer declares their funding in the portal questionnaire — deposit,
 * sources, institutions, a narrative — and that answer sits in the submission
 * snapshot. `aml.source_of_funds` is the canonical evidence table, with a
 * complete server op (`upsert_sof`: allowlisted columns, server-stamped
 * verifier, write-role gated) and a client API — **and no UI called it.**
 *
 * So Stage 6 said "No source of funds recorded" while the customer's own
 * declaration listed two sources one table away, and the stage's own button
 * opened a section with nothing actionable on it. The analyst's actual job —
 * turn the declaration into recorded, verified evidence — had no surface.
 *
 * ── The line every function here holds ────────────────────────────────
 * **A declaration is evidence towards verification; it is never the
 * verification.** Drafts seeded from the customer's answer always arrive
 * `verified: false`. Verifying is a person's act, recorded with the
 * verifier's name — the server stamps `verified_by` from the session and
 * discards any caller-supplied value.
 */

export interface DeclaredFunding {
  deposit?: string | number | null;
  sources?: unknown;
  overseas?: string | null;
  narrative?: string | null;
  institutions?: string | null;
}

export interface SofItemFacts {
  id?: string;
  source_type: string;
  description: string | null;
  amount: number | null;
  currency: string;
  verified: boolean;
  verified_at?: string | null;
  verified_by?: string | null;
  notes?: string | null;
}

/** A row ready to be recorded. Deliberately not a `SofItemFacts`: no id, and
 *  no way to spell `verified: true`. */
export interface SofDraft {
  source_type: string;
  description: string;
  amount: null;
  currency: "AUD";
  notes: string;
}

/**
 * The portal's source labels → `source_type` codes.
 *
 * Declared, not fuzzy-matched. An unrecognised label becomes `other` with the
 * label kept verbatim in the description — the failure mode of a new portal
 * option is an ugly code, never a silently wrong classification.
 */
export const DECLARED_SOURCE_TYPE: Record<string, string> = {
  "salary savings": "savings",
  "savings": "savings",
  "salary": "employment_income",
  "loan / mortgage": "loan",
  "loan": "loan",
  "gift": "gift",
  "gift from family": "gift",
  "sale of property": "property_sale",
  "sale of asset": "asset_sale",
  "inheritance": "inheritance",
  "business income": "business_income",
  "investment income": "investment_income",
  "superannuation": "superannuation",
};

export const SOURCE_TYPE_LABEL: Record<string, string> = {
  savings: "Savings",
  employment_income: "Employment income",
  loan: "Loan / mortgage",
  gift: "Gift",
  property_sale: "Sale of property",
  asset_sale: "Sale of asset",
  inheritance: "Inheritance",
  business_income: "Business income",
  investment_income: "Investment income",
  superannuation: "Superannuation",
  other: "Other",
};

const clean = (v: unknown): string => String(v ?? "").trim();

/**
 * Drafts from the customer's declared funding — minus anything already
 * recorded, so pressing the button twice cannot double a source.
 *
 * ── What a draft deliberately does NOT carry ──────────────────────────
 * An amount. The declared deposit is a TOTAL across every source; the
 * customer never said how it splits. Writing `deposit / sources.length`
 * against each row would put a number the customer never stated into an
 * evidence table, and a fabricated figure in CDD evidence is worse than a
 * blank one — the analyst records the real amount when they verify it.
 * The declared total is carried in the notes instead, as context.
 */
export function draftsFromDeclaredFunding(
  declared: DeclaredFunding | null | undefined,
  existing: SofItemFacts[],
): SofDraft[] {
  if (!declared) return [];
  const labels = Array.isArray(declared.sources)
    ? declared.sources.map(clean).filter(Boolean)
    : [];
  if (labels.length === 0) return [];

  const context: string[] = [];
  const deposit = clean(declared.deposit);
  if (deposit) context.push(`declared deposit $${deposit} (total across all sources)`);
  const institutions = clean(declared.institutions);
  if (institutions) context.push(`institutions: ${institutions}`);
  const narrative = clean(declared.narrative);
  if (narrative) context.push(`narrative: “${narrative}”`);
  const note = "Declared by the customer in their portal submission"
    + (context.length ? ` — ${context.join("; ")}.` : ".");

  const held = new Set(existing.map((e) =>
    `${e.source_type}::${clean(e.description).toLowerCase()}`));

  return labels.flatMap((label) => {
    const type = DECLARED_SOURCE_TYPE[label.toLowerCase()] ?? "other";
    const description = label;
    if (held.has(`${type}::${description.toLowerCase()}`)) return [];
    return [{
      source_type: type,
      description,
      amount: null,
      currency: "AUD" as const,
      notes: note,
    }];
  });
}

/** Where the stage stands, in one honest sentence. */
export interface FundingProgress {
  recorded: number;
  verified: number;
  settled: boolean;
  sentence: string;
}

export function fundingProgress(items: SofItemFacts[]): FundingProgress {
  const recorded = items.length;
  const verified = items.filter((i) => i.verified).length;
  const settled = recorded > 0 && verified === recorded;
  return {
    recorded, verified, settled,
    sentence: recorded === 0
      ? "Nothing recorded yet. Record each source of funds, then verify it "
        + "against evidence."
      : settled
        ? `${verified} source${verified === 1 ? "" : "s"} recorded and verified.`
        : `${verified} of ${recorded} source${recorded === 1 ? "" : "s"} verified — `
          + "an unverified source is a claim, not evidence.",
  };
}

/**
 * What the Aurixa Passport will say about this stage.
 *
 * MIRRORS `passportStamps.pure.ts`: the SOURCE OF FUNDS REVIEWED stamp is
 * earned when at least one row is verified, dated by the latest
 * `verified_at`. A source test asserts the two rules cannot drift apart —
 * this module must never promise a stamp the passport will not mint.
 *
 * The stamp is `client_safe`: it appears on the passport the customer and
 * relying partners see. That is the whole reason to surface it here — the
 * verifying analyst is producing something outward-facing, and should know.
 */
export interface PassportStampReadiness {
  earned: boolean;
  earnedAt: string | null;
  sentence: string;
}

export function passportSofStampReadiness(items: SofItemFacts[]): PassportStampReadiness {
  const dates = items
    .filter((i) => i.verified)
    .map((i) => clean(i.verified_at))
    .filter(Boolean)
    .sort();
  const earnedAt = dates.length ? dates[dates.length - 1] : null;
  return {
    earned: earnedAt !== null,
    earnedAt,
    sentence: earnedAt
      ? `The Aurixa Passport carries SOURCE OF FUNDS REVIEWED, dated `
        + `${earnedAt.slice(0, 10)}. It is client-safe: the customer and relying `
        + "partners see it."
      : "Verifying a source earns SOURCE OF FUNDS REVIEWED on the Aurixa "
        + "Passport — a client-safe stamp the customer and relying partners see. "
        + "Recording alone does not earn it.",
  };
}
