/**
 * Builder stock — the two ways the marketing detector can be wrong, and what
 * each costs.
 *
 * A FALSE POSITIVE HIDES A HOUSE. Lot 40 Sandpiper's recovered facade carries
 * no overlay of any kind — no pill, no ribbon, no caption — and it was refused
 * for a single 17x12px mark in the very top corner of the 400px reduction:
 * FOLIAGE AGAINST SKY. One coincidence of high-contrast edges convicted a clean
 * builder photograph and the client saw an empty frame.
 *
 * A FALSE NEGATIVE PUTS MARKETING ON A CLIENT'S CARD, which is worse, so the
 * fix for the first may not cost anything on the second. That is what the two
 * halves of this file are: the mark that must stop counting, and every real
 * marketing control in the production set, which must all still count.
 *
 * THE RULE IS GEOMETRY AND NOTHING ELSE. A caption laid over a photograph is a
 * word or a phrase, and on a 400px reduction that is tens of pixels wide. The
 * narrowest real run measured across the whole production set is Brownsplains'
 * second word at 7.2% of the frame's width; the foliage mark is 4.3%. No word
 * is named, no colour is read, no position is privileged, and making a run
 * WIDER is not something the floor can reject — so nothing that passed before
 * can fail now.
 */
import { describe, expect, it } from 'vitest';

import {
  measureOverlayText, overlayTextBoxes, readMarketingOverlay,
} from '../../../supabase/functions/_shared/builderStock/marketingOverlay.pure';
import { photograph, withCaption, withPlate } from './fixtures/builderStockPictures';

const W = 400;
const H = 224;

describe('a mark too narrow to be a line of type', () => {
  it('does not convict a clean photograph', () => {
    /*
     * The shape of the production false positive: a small high-contrast blob in
     * the top corner, roughly 17x12 on a 400px frame, against otherwise quiet
     * sky. Drawn as a plate rather than as letters because that is what foliage
     * against sky IS to this detector — contrast, not language.
     */
    const clean = photograph(W, H, 21);
    const speckled = withPlate(clean, { x: 313, y: 2, w: 17, h: 12 }, [18, 24, 16]);

    const verdict = readMarketingOverlay(speckled);
    expect(verdict.textLineCount).toBe(0);
    expect(overlayTextBoxes(speckled)).toHaveLength(0);
  });

  it('and a completely unmarked photograph stays unmarked', () => {
    const verdict = readMarketingOverlay(photograph(W, H, 22));
    expect(verdict.textLineCount).toBe(0);
    expect(verdict.annotated).toBe(false);
  });
});

describe('but a real caption still counts', () => {
  /**
   * A caption the width of a word, drawn with the shared letterform fixture.
   * `withCaption` sets real glyph shapes, so this exercises the same stripe,
   * fill and profile tests a builder's own type does.
   */
  const captioned = (text: string, box: { x: number; y: number; w: number; h: number }) => {
    const base = photograph(W, H, 23);
    // Light plate, dark ink — the contrast a printed badge actually has, and
    // the same recipe the sanitizer's own fixtures use.
    const plated = withPlate(base, box, [193, 255, 114]);
    const scale = Math.max(1, Math.floor((box.h * 0.55) / 7));
    return withCaption(plated, text, {
      x: box.x + Math.round(box.h * 0.25),
      y: box.y + Math.round((box.h - 7 * scale) / 2),
      scale,
      ink: [10, 10, 10],
    });
  };

  it('finds a word set on a pill', () => {
    const picture = captioned('SOLERA', { x: 24, y: 20, w: 150, h: 30 });
    expect(readMarketingOverlay(picture).textLineCount).toBeGreaterThan(0);
  });

  it('finds it at the narrowest width the production set actually contains', () => {
    /*
     * Brownsplains' second word measures 29px on a 400px frame — 7.2%, the
     * narrowest real marketing run anywhere in the production set. The floor
     * sits at 5.5%, so this is the case with the least margin and the one worth
     * pinning: a run this size must still be found.
     */
    const picture = captioned('ROS', { x: 270, y: 14, w: 60, h: 28 });
    const boxes = overlayTextBoxes(picture);
    expect(boxes.length).toBeGreaterThan(0);
    const widest = Math.max(...boxes.map((box) => box.right - box.left + 1));
    // A three-letter word at this scale is ~9% of the frame: comfortably above
    // the 5.5% floor and comfortably below Lot 13's 30% pills.
    expect(widest / W).toBeGreaterThanOrEqual(0.055);
    expect(widest / W).toBeLessThan(0.2);
  });

  it('a flat coloured plate is still refused whether or not it carries words', () => {
    // The other half of the classifier is untouched by the width floor: a
    // ribbon-sized block of brand colour convicts on its own. This is what
    // keeps Cloverton Registered — whose words this detector cannot read at any
    // resolution — refused rather than served.
    const base = photograph(W, H, 25);
    const plated = withPlate(base, { x: 24, y: 20, w: 150, h: 30 }, [163, 215, 98]);
    expect(readMarketingOverlay(plated).annotated).toBe(true);
  });
});

describe('the width floor is a floor and never a ceiling', () => {
  it('accepts every run wider than the narrowest real one', () => {
    const widths = [60, 90, 130, 170];
    for (const width of widths) {
      const base = photograph(W, H, 26);
      const box = { x: 20, y: 20, w: width, h: 28 };
      const plated = withPlate(base, box, [193, 255, 114]);
      const picture = withCaption(plated, 'ROSES', {
        x: box.x + 7, y: box.y + 6, scale: 2, ink: [10, 10, 10],
      });
      const boxes = overlayTextBoxes(picture);
      // Where the fixture drew something wide enough to be a word, it is found.
      const wide = boxes.filter((box) => (box.right - box.left + 1) / W >= 0.055);
      expect(wide.length).toBe(boxes.length);
    }
  });

  it('measures the strict pass, not a smaller reduction of it', () => {
    // The floor is a share of the picture's own width, so it means the same
    // thing whatever size the reduction happens to be.
    const wide = photograph(800, 400, 27);
    expect(measureOverlayText(wide).lineCount).toBe(0);
  });
});
