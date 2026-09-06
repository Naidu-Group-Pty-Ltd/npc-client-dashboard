/**
 * Builder stock — a cover that draws one photograph far larger than the rest
 * HAS said which is the property's.
 *
 * MEASURED, 3 SEPTEMBER 2026. A builder's own single-property brochure was
 * uploaded as a stock list (LOT 1731 VERV UND VANTA 23, Austin Estate, Lara).
 * Both photographs on page 1 were found, attributed and stored — a 1819×1223
 * render covering 47.5% of the page and a 1280×720 image covering 14.2% — and
 * the card read "No image found", because the cover rule refused every page
 * presenting more than one photograph. Ownership was never in doubt; only
 * which one leads was, and the page had already answered that by how it drew
 * them.
 *
 * The refusal stays wherever the page really is presenting a choice.
 */
import { describe, expect, it } from 'vitest';

import {
  DOMINANT_COVER_RATIO, selectCoverHero,
} from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';

const candidate = (key: string, pageAreaShare: number | null, over: Partial<{
  placementsOnPage: number; pagesDrawnOn: number;
}> = {}) => ({
  key, pageAreaShare,
  placementsOnPage: over.placementsOnPage ?? 1,
  pagesDrawnOn: over.pagesDrawnOn ?? 1,
});

describe('selectCoverHero — the cover states its hero by size', () => {
  it('takes the photograph the real brochure draws largest', () => {
    // The production geometry, to four places, exactly as stored.
    const outcome = selectCoverHero([
      candidate('im2', 0.1417),
      candidate('im3', 0.4753),
    ]);
    expect(outcome.kind).toBe('hero');
    if (outcome.kind === 'hero') {
      expect(outcome.key).toBe('im3');
      expect(outcome.reason).toContain('48% of the page');
      expect(outcome.reason).toContain('14%');
    }
  });

  it('still refuses two photographs of comparable size', () => {
    const outcome = selectCoverHero([
      candidate('a', 0.30),
      candidate('b', 0.28),
    ]);
    expect(outcome.kind).toBe('none');
    if (outcome.kind === 'none') {
      expect(outcome.reason).toContain('comparable size');
      expect(outcome.reason).toContain('does not say which');
    }
  });

  it('the ratio is the threshold, and it is exactly twice', () => {
    // At the line: admitted.
    expect(selectCoverHero([candidate('a', 0.20), candidate('b', 0.40)]).kind).toBe('hero');
    // A hair under it: refused.
    expect(selectCoverHero([candidate('a', 0.201), candidate('b', 0.40)]).kind).toBe('none');
    expect(DOMINANT_COVER_RATIO).toBe(2);
  });

  it('infers nothing where a candidate could not be measured', () => {
    const outcome = selectCoverHero([candidate('a', null), candidate('b', 0.60)]);
    expect(outcome.kind).toBe('none');
  });

  it('repetition still eliminates before size is consulted', () => {
    // The Lot 537 case: a huge repeated wash is furniture, not the hero, so
    // the one photograph drawn once wins without the ratio being reached.
    const outcome = selectCoverHero([
      candidate('wash', 0.80, { placementsOnPage: 3 }),
      candidate('facade', 0.10),
    ]);
    expect(outcome.kind).toBe('hero');
    if (outcome.kind === 'hero') expect(outcome.key).toBe('facade');
  });

  it('a cover presenting nothing, and one presenting only repeats, are unchanged', () => {
    expect(selectCoverHero([]).kind).toBe('none');
    const allRepeated = selectCoverHero([
      candidate('a', 0.5, { pagesDrawnOn: 4 }),
      candidate('b', 0.2, { placementsOnPage: 2 }),
    ]);
    expect(allRepeated.kind).toBe('none');
    if (allRepeated.kind === 'none') expect(allRepeated.reason).toContain('artwork the document repeats');
  });

  it('one photograph is still taken without any measurement at all', () => {
    const outcome = selectCoverHero([candidate('only', null)]);
    expect(outcome.kind).toBe('hero');
    if (outcome.kind === 'hero') expect(outcome.key).toBe('only');
  });
});
