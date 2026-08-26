/**
 * Builder stock — WHICH page of a PDF is the property's cover, and which
 * picture on it is the hero.
 *
 * This is LEVEL 2 of `sourceImageRole.pure.ts` for a paginated document, and it
 * is the half the pipeline never had. `pdfPageImages.pure.ts` finds every
 * picture a page draws and rejects the ones that cannot be photographs;
 * everything after that used to be "the largest one, on the first page that has
 * one", which is a statement about rasters and never about the property.
 *
 * WHAT IT COST. The live Lot 537 Kirramingly Avenue contract has, on the page a
 * person opens first, the lot and street, the estate, the house design, the
 * fixed contract price, the land and build sizes, and one large facade render.
 * On its third page it has "INCLUSIONS" and a bedroom. The old rule reached the
 * third page and took the bedroom, because the bedroom is 2202×1229 and the
 * page draws it across the full bleed. Both pictures are the builder's; only
 * one of them is what this property looks like from the street.
 *
 * THE RULE, AND IT ONLY EVER ANSWERS FROM THE DOCUMENT'S OWN WORDS:
 *
 *   1. A page is a PROPERTY COVER when it states the property's IDENTITY — the
 *      lot, address or reference the row was imported under — together with its
 *      PACKAGE INFORMATION: a price, a configuration, a land or build size, a
 *      contract or package heading. Identity alone is not enough (a floorplan
 *      page repeats the lot) and package facts alone are not enough (an
 *      inclusions page quotes prices).
 *   2. The hero is the ONE candidate picture on that page which the page does
 *      not draw more than once and which no other page of the document also
 *      draws. Repetition is the document telling us a picture is furniture — a
 *      bleed wash, a banner, a letterhead — and furniture is never one
 *      property's listing image.
 *   3. Anything else — no cover page, no surviving candidate, or two of them —
 *      is NO PRIMARY. Not the biggest, not the first, not the most detailed.
 *
 * Nothing here reads a page NUMBER as meaningful. Page one is not privileged;
 * the cover of a package is wherever the package puts it, and a document whose
 * page order we could not establish is refused outright rather than counted.
 *
 * Pure: no imports beyond the role vocabulary and the label reading it shares
 * with `drivePackage.pure.ts`, no IO, no clock.
 */
import { withoutTenureWording } from './drivePackage.pure.ts';
import {
  noPrimaryEvidence, roleFromAssetName, roleFromPropertyCover, secondaryRole,
  type SourceImageRoleAssignment,
} from './sourceImageRole.pure.ts';

/** What made a page the property's cover. Recorded, never inferred. */
export interface PropertyCoverEvidence {
  /** 1-based, the way a person counts pages. */
  page: number;
  /** The property identity the page stated. */
  identity: string;
  /** The package facts it stated alongside. */
  packageFacts: string[];
}

/**
 * Package information a property's own cover states.
 *
 * Each is a fact about the DEAL rather than about the building, which is what
 * separates a package cover from a floorplan page that repeats the lot number
 * and from a gallery page that repeats the address.
 */
const PACKAGE_FACTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['a package price', /(?:\$|aud\s*)\s?\d{1,3}(?:[, ]\d{3})+(?:\.\d{2})?/i],
  ['a contract or package heading', /\b(fixed\s*price\s*contract|price\s*contract|house\s*(?:and|&|\+)\s*land|package|single\s*contract|two\s*part\s*contract|turnkey|build\s*contract|hia\s*contract)\b/i],
  ['a land or build size', /\b(land\s*size|build\s*size|lot\s*size|house\s*size|floor\s*area|\d{2,4}\s*m\s*2|\d{2,4}\s*sqm)\b/i],
  ['a bedroom/bathroom/car configuration', /\b\d\s*(bed|bedroom|bath|bathroom|car|garage)s?\b/i],
  ['a title or completion date', /\b(title\s*reg|titled|registration|est(?:imated)?\.?\s*completion|handover)\b/i],
  ['a lot dimension', /\b(lot\s*width|lot\s*length|frontage)\b/i],
];

/** Tokens of a label, in order, punctuation and case removed. */
function tokenise(value: string): string[] {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0);
}

/**
 * How much of the property's label a page must repeat to be naming it.
 *
 * The same set-matching `pdfRowAnchors.pure.ts` uses and for the same reason: a
 * PDF breaks lines wherever the layout did, so "Lot 537 Kirramingly Avenue,
 * Donnybrook" arrives as three fragments. Requiring several tokens keeps
 * "Lot 5" from matching every page that mentions a five.
 */
const MIN_IDENTITY_TOKENS = 2;
const MAX_IDENTITY_TOKENS = 8;

/**
 * The lot or unit numbers a piece of text designates.
 *
 * "Lot 51", "LOT 914", "Unit 3" — the word and the number that follows it. This
 * is the one token in a property's label that DISCRIMINATES: an estate's
 * documents all repeat the estate, the suburb and the state, and only the lot
 * number says which house.
 */
function lotDesignations(value: string): string[] {
  const tokens = tokenise(value);
  const found: string[] = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index] !== 'lot' && tokens[index] !== 'unit') continue;
    const next = tokens[index + 1];
    if (/^\d{1,5}$/.test(next)) found.push(next);
  }
  return found;
}

/**
 * The design or product a label names in brackets — "[Miami 190]".
 *
 * The SECOND discriminator, and on the live list it is the only one that
 * separates seven stock rows from each other: Lot 51 carries Miami 190, Miami
 * 196, Stradbroke 180, Stradbroke 197, Bishop 258, Bravo 217 and Echo 236, all
 * at the same address and the same lot. A rule that ignored it would let one
 * design's cover be served for another design's row.
 */
function designTokens(label: string): string[] {
  const bracketed = String(label ?? '').match(/\[([^\]]{1,60})\]/g) ?? [];
  /*
   * READ THE SAME WAY THE DOCUMENT WAS CHOSEN. `lotAndDesignFrom` drops the
   * tenure wording the stock list puts in this bracket, because the builder's
   * own file and its own cover never carry it — so requiring it here refused
   * the very document that reading had just selected. See
   * `withoutTenureWording`.
   */
  return bracketed.flatMap((part) => tokenise(withoutTenureWording(part)));
}

/**
 * Does this page state that it is about THIS property?
 *
 * WHAT THIS REPLACES, AND WHY IT WAS WRONG. The rule used to be "every one of
 * the label's first eight tokens appears on the page", and it is the reason
 * twenty-five live properties show no photograph. The label comes from the
 * stock list — "Lot 51 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW
 * 2486 [Miami 190]" — and the builder's own package cover for that exact
 * property says "Lot 51, Sandpiper Estate, Tweed Heads NSW · Miami 190,
 * Spectral façade". It names the lot, the estate, the suburb, the state and the
 * design. It does not name the STREET, and it writes "Tweed Heads" where the
 * list writes "Tweed Heads South". So `tringa` and `street` are missing, the
 * conjunction fails, and a page that could not identify the property more
 * plainly is refused.
 *
 * Demanding every token is not strictness, it is a demand that two independent
 * documents word an address identically — which nothing makes them do. What
 * actually needs to hold is that the page IDENTIFIES this property and
 * CONTRADICTS nothing about it, and those are the four tests below:
 *
 *   1  THE LOT IS STATED. The label's lot or unit number must appear on the
 *      page as a lot or unit designation. This is the discriminator; without it
 *      there is no identification at all.
 *
 *   2  NO OTHER LOT IS STATED. Every lot the page designates must be this
 *      property's. A page naming Lot 52 is not Lot 51's cover however much of
 *      the rest it shares, and this is what makes relaxing (1)'s neighbours
 *      safe rather than sloppy.
 *
 *   3  THE DESIGN IS STATED, when the label names one. Seven rows share Lot 51
 *      and differ only here, so this is the difference between attributing a
 *      picture and guessing.
 *
 *   4  SOMETHING ELSE CORROBORATES. At least one further label token — the
 *      estate, the suburb, the street where the document does name it — must
 *      appear, so a bare "Lot 51" on an unrelated page cannot qualify.
 *
 * A label with no lot or unit number keeps the OLD conjunction exactly, because
 * for those rows the tokens are all there is and there is no discriminator to
 * lean on. Nothing about this is a similarity score: every test is a statement
 * the document either makes or does not make.
 */
function pageStatesIdentity(pageText: string, label: string): boolean {
  const labelTokens = tokenise(label);
  if (labelTokens.length < MIN_IDENTITY_TOKENS) return false;

  const haystack = ` ${tokenise(pageText).join(' ')} `;
  const states = (token: string) => haystack.includes(` ${token} `);

  const labelLots = lotDesignations(label);
  if (!labelLots.length) {
    // No discriminator of its own. The old rule, unchanged.
    return labelTokens.slice(0, MAX_IDENTITY_TOKENS).every(states);
  }

  // 1 — the lot is stated, as a lot.
  const pageLots = lotDesignations(pageText);
  if (!pageLots.some((lot) => labelLots.includes(lot))) return false;

  // 2 — and no other lot is.
  if (pageLots.some((lot) => !labelLots.includes(lot))) return false;

  // 3 — the design, when the label names one.
  const design = designTokens(label);
  if (design.length && !design.every(states)) return false;

  /*
   * 4 — and at least one corroborating token that is not the lot itself.
   *
   * WHEN THE LABEL HAS NOTHING ELSE, the lot designation IS the whole of its
   * identity and there is nothing to corroborate with. A row whose source gave
   * it only "Lot 7" is accepted on the lot alone — exactly as the previous rule
   * accepted it, since its every token was then the lot too. Requiring
   * corroboration a label cannot supply would refuse those rows for being
   * sparsely described, which is not evidence about the document.
   */
  const corroborating = labelTokens.filter((token) =>
    token !== 'lot' && token !== 'unit' && !labelLots.includes(token)
    && !design.includes(token));
  if (!corroborating.length) return true;
  return corroborating.some(states);
}

/** The package facts a page states, in the order they are defined above. */
export function packageFactsOn(pageText: string): string[] {
  const text = String(pageText ?? '');
  const found: string[] = [];
  for (const [name, pattern] of PACKAGE_FACTS) {
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

/** How many package facts a cover must state. One is a coincidence. */
const MIN_PACKAGE_FACTS = 2;

/**
 * The page (or pages) that present this property as a package.
 *
 * `pageTexts[i]` is the text of visible page `i + 1`. More than one match is
 * returned rather than resolved, because a document that presents the same
 * property twice has not told us which presentation is its cover — and the
 * caller's answer to that is no primary image.
 */
export function findPropertyCoverPages(
  pageTexts: string[],
  label: string | null | undefined,
): PropertyCoverEvidence[] {
  const identity = String(label ?? '').trim();
  if (!identity) return [];

  const covers: PropertyCoverEvidence[] = [];
  (pageTexts ?? []).forEach((text, index) => {
    if (!pageStatesIdentity(text ?? '', identity)) return;
    const packageFacts = packageFactsOn(text ?? '');
    if (packageFacts.length < MIN_PACKAGE_FACTS) return;
    covers.push({ page: index + 1, identity, packageFacts });
  });
  return covers;
}

// ---------------------------------------------------------------------------
// Which picture on that page is the hero
// ---------------------------------------------------------------------------

/** A candidate picture, reduced to what this decision is allowed to see. */
export interface CoverCandidate {
  /** Identifies the raster within the document. */
  key: string;
  /** How many times the cover page draws it. */
  placementsOnPage: number;
  /** How many pages of the document draw it at all. */
  pagesDrawnOn: number;
}

export type CoverHeroOutcome =
  | { kind: 'hero'; key: string; reason: string }
  | { kind: 'none'; reason: string };

/**
 * The one picture on a property's cover page that is its hero.
 *
 * REPETITION IS THE ONLY THING THAT ELIMINATES, and it eliminates by what the
 * document did rather than by what the picture looks like. A raster the cover
 * draws twice, or that a second page also draws, is the design's furniture: on
 * the Lot 537 cover that is the grey faceted wash, placed three times, which
 * every size and encoding rule admits and which is bigger on the page than the
 * facade it sits behind.
 *
 * What survives has to be exactly one. Two surviving photographs on a cover is
 * a page presenting a choice, and this does not make choices — see LEVEL 4.
 */
export function selectCoverHero(candidates: CoverCandidate[]): CoverHeroOutcome {
  const all = candidates ?? [];
  if (!all.length) {
    return { kind: 'none', reason: 'the property cover page presents no photograph' };
  }

  const unique = all.filter(
    (candidate) => candidate.placementsOnPage <= 1 && candidate.pagesDrawnOn <= 1,
  );
  if (unique.length === 1) {
    const dropped = all.length - unique.length;
    return {
      kind: 'hero',
      key: unique[0].key,
      reason: dropped
        ? `the only photograph the property cover presents once; ${dropped} other `
          + 'raster(s) on that page are repeated artwork the document reuses'
        : 'the only photograph the property cover presents',
    };
  }
  if (!unique.length) {
    return {
      kind: 'none',
      reason: 'every photograph on the property cover is artwork the document repeats, '
        + 'so none of them is this property\'s own image',
    };
  }
  return {
    kind: 'none',
    reason: `the property cover presents ${unique.length} photographs and does not say `
      + 'which is the property\'s, so none is used',
  };
}

// ---------------------------------------------------------------------------
// The one decision, for every caller
// ---------------------------------------------------------------------------

/** One discovered picture, reduced to what the source said about where it sits. */
export interface PdfMediaPlacement {
  /** 1-based, the page a person sees. */
  page: number;
  /** The resource/file name the document gave it, when it gave one. */
  name: string | null;
  /** How many times its own page draws it. */
  placementsOnPage: number;
  /** How many pages of the document draw it. */
  pagesDrawnOn: number;
}

/**
 * The role of EVERY picture found in one PDF, index-aligned with the input.
 *
 * ONE implementation, three callers — a PDF uploaded straight into the portal,
 * the same PDF re-read by a repair, and a package PDF reached through a stock
 * row's own link. They must not be able to disagree about which picture is a
 * property's hero, which is exactly the class of drift that produced two
 * competing brochure readers in the first place.
 *
 * At most ONE assignment comes back as `primary_property`, and only when the
 * document said so.
 */
export function assignPdfMediaRoles(input: {
  label: string | null | undefined;
  pageTexts: string[];
  pageOrderAuthoritative: boolean;
  media: PdfMediaPlacement[];
  /**
   * THE DOCUMENT IS ALREADY KNOWN TO BE THIS PROPERTY'S, AND IT CANNOT SAY SO.
   *
   * Set only where the containing document was tied to exactly one stock row by
   * the builder's OWN structure — one folder named for the lot, one PDF in it
   * naming that lot and that design, `selectPackageDocument`'s exactly-one-or-
   * nothing — and where the document's pages then yielded no extractable text
   * whatsoever.
   *
   * That combination is a real document in the live library:
   * "LOT 914 • COVELLA • GREENBANK QLD.pdf" is three pages of designed brochure
   * exported as images, whose first page carries the lot, the estate, the price,
   * both sizes and the facade render, all drawn rather than set. Nothing on that
   * page can be read, so `findPropertyCoverPages` can never designate it — and
   * the property has a photograph the source names perfectly well.
   *
   * WHAT THIS IS NOT. It is emphatically not "a PDF with no text, so use page
   * one": that rule would attribute the first picture in any unreadable
   * document to whichever property happened to be asking. The attribution here
   * does not come from the page at all — it was already made, by name, before a
   * byte was downloaded — and this only supplies the page number that
   * attribution implies. Where the folder named two candidate documents, or
   * none, there is no tie and nothing reaches this.
   *
   * AND IT STILL HAS TO BE A COVER. `selectCoverHero` runs unchanged below, so
   * a first page presenting no photograph, or presenting several, or presenting
   * only artwork the document repeats elsewhere, yields nothing exactly as it
   * would for a page whose text was read. A floorplan or a masterplan on page 1
   * is not promoted by this; it is refused by the same rule that refuses it
   * today.
   */
  structuralCoverPage?: number | null;
}): SourceImageRoleAssignment[] {
  const media = input.media ?? [];
  const covers = input.pageOrderAuthoritative
    ? findPropertyCoverPages(input.pageTexts ?? [], input.label)
    : [];
  const structural = input.pageOrderAuthoritative
    && Number.isInteger(input.structuralCoverPage)
    && (input.structuralCoverPage as number) > 0
    && !covers.length
    // Only where NOTHING could be read. A document whose text was read and did
    // not name this property has answered the question, and this must not
    // overrule it.
    && (input.pageTexts ?? []).every((text) => !String(text ?? '').trim())
    ? {
      page: input.structuralCoverPage as number,
      identity: String(input.label ?? ''),
      packageFacts: ['the builder\'s own folder names this document for this property'],
    }
    : null;
  const cover = covers.length === 1 ? covers[0] : structural;

  const onCover = cover
    ? media
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.page === cover.page)
    : [];

  const outcome = cover
    ? selectCoverHero(onCover.map(({ entry, index }) => ({
      key: String(index),
      placementsOnPage: entry.placementsOnPage,
      pagesDrawnOn: entry.pagesDrawnOn,
    })))
    : null;

  const heroIndex = outcome?.kind === 'hero' ? Number(outcome.key) : -1;

  // Why nothing is primary, said once and in the source's own terms, so the
  // stored record explains itself without anybody re-running the import.
  const refusal = !input.pageOrderAuthoritative
    ? 'the document\'s own page order could not be established, so no page can be read as '
      + 'this property\'s cover'
    : !(input.pageTexts ?? []).length
      ? 'the document\'s text could not be read, so no page can be read as this property\'s cover'
      : !String(input.label ?? '').trim()
        ? 'the property has no label for a page to state, so no page can be read as its cover'
        : covers.length > 1
          ? `${covers.length} pages present this property as a package and the document does `
            + 'not say which is its cover'
          : !covers.length
            ? 'no page states this property\'s identity together with its package information'
            : outcome?.kind === 'none'
              ? outcome.reason
              : 'the source does not designate a primary image for this property';

  return media.map((entry, index) => {
    /**
     * A name the builder chose may DEMOTE and never promote. `Masterplan.png`
     * is not a house whatever page it sits on; `6.png` is a perfectly ordinary
     * name for a facade render, so a hero word in a filename proves nothing
     * about which property it belongs to or what the source presented it as.
     */
    const named = roleFromAssetName(entry.name);
    if (named) {
      return secondaryRole(named, `the source names this image "${entry.name}"`);
    }
    if (index === heroIndex && cover) {
      return roleFromPropertyCover({
        where: `visible page ${cover.page}`,
        identity: cover.identity,
        packageFacts: cover.packageFacts,
      });
    }
    return noPrimaryEvidence(refusal);
  });
}

/**
 * The same decision for a document that produced SEVERAL properties.
 *
 * Each property is judged against the pages attributed to it and against its
 * own label, so a stock PDF listing twelve lots resolves twelve covers rather
 * than one — and a picture the document tied to nobody stays tied to nobody.
 *
 * Index-aligned with `media`, like everything else on this path, because the
 * caller writes one storage row per entry and a misalignment here would put one
 * property's evidence on another property's picture.
 */
export function assignPdfMediaRolesPerProperty(input: {
  media: Array<{ name: string; placement?: PdfMediaPlacement | null }>;
  /** The property each picture reached, index-aligned. Null is unattributed. */
  stockItemIds: Array<string | null>;
  labelByItemId: Map<string, string>;
  pageTexts: string[];
  pageOrderAuthoritative: boolean;
}): SourceImageRoleAssignment[] {
  const media = input.media ?? [];
  const out: SourceImageRoleAssignment[] = media.map(() => noPrimaryEvidence(
    'the source did not tie this image to a property, so it is kept against the upload '
    + 'and shown against nobody'));

  const byProperty = new Map<string, number[]>();
  media.forEach((_, index) => {
    const itemId = input.stockItemIds[index];
    if (!itemId) return;
    const bucket = byProperty.get(itemId) ?? [];
    bucket.push(index);
    byProperty.set(itemId, bucket);
  });

  for (const [itemId, indexes] of byProperty) {
    const assignments = assignPdfMediaRoles({
      label: input.labelByItemId.get(itemId) ?? null,
      pageTexts: input.pageTexts,
      pageOrderAuthoritative: input.pageOrderAuthoritative,
      media: indexes.map((index) => media[index].placement ?? {
        // A picture with no placement was not read by the page reader, so
        // nothing is known about where the document put it.
        page: 0, name: media[index].name, placementsOnPage: 2, pagesDrawnOn: 2,
      }),
    });
    indexes.forEach((index, position) => { out[index] = assignments[position]; });
  }
  return out;
}
