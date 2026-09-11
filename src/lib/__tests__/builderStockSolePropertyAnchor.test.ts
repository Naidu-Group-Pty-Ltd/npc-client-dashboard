/**
 * Builder stock — a seven-page brochure that stored NOTHING.
 *
 * MEASURED 11 SEPTEMBER 2026 on `LOT 717 - ENZO 10.5 MODERN - BROCHURE V002.pdf`,
 * the builder's own file. Seven pages, seventeen embedded images, all seven
 * pages carrying extractable text, and the property imported perfectly — price
 * $741,655, 3 bed, 2 bath, 271 m² land, "Society 1056". Zero images were
 * stored against it. The card fell through to an internet search, which
 * returned two dead realestate.com.au URLs, and went out blank.
 *
 * THE CHAIN. `repairSourceImages` reads a row's pictures out of
 * `assetsByAnchor.get(anchor)`, and its one line for a row without one is
 *
 *     const assets = anchor ? assetsByAnchor.get(anchor) ?? [] : [];
 *
 * so `source_anchor: null` means the document's images are extracted, indexed,
 * and never asked for. Measured across every PDF this builder has uploaded,
 * the correlation is total — anchor present: images stored; anchor null: none.
 *
 * AND THE ANCHOR WAS REFUSED FOR A REASON THAT DOES NOT APPLY. Pages 1 and 2
 * BOTH state "Lot 717, Serenity Road" with package facts: page 1 is the cover
 * carrying the 1920x1080 render, page 2 is the siting plan carrying the same
 * address block. `anchorPdfRowsToPages` saw two covers and returned null —
 * correct for a document listing MANY properties, where two pages naming one
 * lot is the document declining to say which is its record and a guess puts
 * somebody else's house on a card. With exactly ONE property there is nothing
 * else in the document to confuse it with. The question is not "whose page is
 * this" but "which of this property's pages leads", and `resolvePropertyCover`
 * had been answering it all along — the election opens with
 * `resolvePropertyCover(covers) ?? structural` and, run against this file,
 * elects page 1 with full cover evidence in 944 ms.
 *
 * So the anchor was refusing a document the election could read. One resolver,
 * both callers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  anchorPdfRowsToPages, pdfAnchorPage,
} from '../../../supabase/functions/_shared/builderStock/pdfRowAnchors.pure';
import {
  findPropertyCoverPages, resolvePropertyCover,
} from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';

const ANCHORS = readFileSync(join(process.cwd(),
  'supabase/functions/_shared/builderStock/pdfRowAnchors.pure.ts'), 'utf8');

const LABEL = 'Lot 717, Serenity Road';

/** Page 1 — the cover. Verbatim lines from the builder's file. */
const COVER = [
  'Enzo 10.5',
  'Land - $379,000',
  'Build - $362,655',
  'Package Price - $741,655',
  'Lot Size',
  'Landscaping to front and rear yards.',
  'Lot 717, Serenity Road',
].join('\n');

/**
 * Page 2 — the siting plan, which states the same address. Verbatim lines.
 * Measured: page 1 carries three package facts (a package price, a contract or
 * package heading, a land or build size); page 2 carries two (a land or build
 * size, a bedroom/bathroom/car configuration). That is the margin
 * `resolvePropertyCover` reads.
 */
const SITING = [
  'MASTER', 'ROBE', 'ENS', 'BATH', 'LIN', 'GARAGE', 'BED 2', 'BED 3',
  'KITCHEN', 'FAMILY/MEALS', 'PORCH', 'L-DRY', 'ENTRY',
  'Site Area: 270.88 m2',
  'Build Area: 131.55 m2',
  'Note: This is a preliminary siting and is subject to a clear copy of title.',
  'Site Address: Lot 717 SERENITY ROAD',
  'Locality: FRASER RISE (3336)',
  'Home Design: ENZO 10.5 - MODERN',
].join('\n');

const PAGES = [COVER, SITING, 'Inclusions', 'Inclusions', 'Zoning', 'Terms', 'Terms'];

describe('the document really does name the property twice', () => {
  it('finds a cover on BOTH pages, which is what triggered the refusal', () => {
    const covers = findPropertyCoverPages(PAGES, LABEL);
    expect(covers.map((cover) => cover.page)).toEqual([1, 2]);
  });

  it('and page 1 leads on package facts, which is what settles it', () => {
    const covers = findPropertyCoverPages(PAGES, LABEL);
    const facts = Object.fromEntries(covers.map((c) => [c.page, c.packageFacts.length]));
    expect(facts[1]).toBeGreaterThan(facts[2]);
  });

  it('and the resolver already knew which one leads', () => {
    const chosen = resolvePropertyCover(findPropertyCoverPages(PAGES, LABEL));
    expect(chosen?.page).toBe(1);
  });
});

describe('a single-property document anchors instead of giving up', () => {
  it('anchors Lot 717 to the page carrying the render', () => {
    expect(anchorPdfRowsToPages([LABEL], PAGES)).toEqual(['pdf:page1']);
  });

  it('agrees with the resolver, rather than having its own opinion', () => {
    const chosen = resolvePropertyCover(findPropertyCoverPages(PAGES, LABEL));
    const [anchor] = anchorPdfRowsToPages([LABEL], PAGES);
    expect(pdfAnchorPage(anchor)).toBe(chosen?.page);
  });

  it('uses the ONE resolver the election uses', () => {
    // Two implementations of "which of this property's pages leads" is how the
    // anchor came to refuse a document the election could read.
    expect(ANCHORS).toContain('resolvePropertyCover');
    expect(ANCHORS).not.toMatch(/if \(covers\.length > 1\) return \[null\];/);
  });

  it('still refuses a genuine tie, because the resolver does', () => {
    // Two pages carrying the SAME number of package facts: the resolver
    // answers null and the anchor must not invent a winner.
    const twin = [COVER, COVER, 'Inclusions'];
    expect(resolvePropertyCover(findPropertyCoverPages(twin, LABEL))).toBeNull();
    expect(anchorPdfRowsToPages([LABEL], twin)).toEqual([null]);
  });
});

describe('what deliberately did not change', () => {
  it('a MULTI-property document still refuses a lot named on two pages', () => {
    /*
     * The rule this relaxes exists for exactly this case, and it stands: with
     * other properties in the document, two pages naming one lot is the
     * document declining to say which is its record, and a guess becomes
     * somebody else's house on a client's card.
     */
    const pages = [COVER, COVER, 'Lot 900, Other Street\nPackage Price - $600,000\nLot Size'];
    const anchors = anchorPdfRowsToPages([LABEL, 'Lot 900, Other Street'], pages);
    expect(anchors[0]).toBeNull();
    expect(anchors[1]).toBe('pdf:page3');
  });

  it('a single cover still anchors straight to it', () => {
    expect(anchorPdfRowsToPages([LABEL], [COVER, 'Inclusions'])).toEqual(['pdf:page1']);
  });

  it('no cover still falls back to the first page with a photograph', () => {
    // Lot 1037's shape: its own page states the address without package facts,
    // so the anchor comes from the photo pages and is unchanged by this.
    expect(anchorPdfRowsToPages([LABEL], ['nothing', 'Site Address: Lot 717 SERENITY ROAD'], [1]))
      .toEqual(['pdf:page1']);
  });

  it('an unordered document still anchors nothing', () => {
    expect(anchorPdfRowsToPages([LABEL], PAGES, [1], false)).toEqual([null]);
  });
});
