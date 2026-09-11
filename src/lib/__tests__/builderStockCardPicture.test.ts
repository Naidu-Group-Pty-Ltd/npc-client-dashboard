/**
 * Builder stock — the ground under a card's picture, and the fact in its title.
 *
 * MEASURED, 11 SEPTEMBER 2026, over every card live on the marketplace. The
 * box is one fixed 16:10 shape and the elected pictures are not:
 *
 *     1.600  11 cards    0.0% bare   fills the box exactly
 *     1.778   7 cards   10.0%
 *     1.416   2 cards   11.5%
 *     2.054   3 cards   22.1%        page crop
 *     0.893   2 cards   44.2%        portrait render
 *     3.584   2 cards   55.4%        page crop, a strip
 *
 * The two portraits were reported as looking "funny" — 44% of the card's
 * picture area was bare ground with the provenance badge floating in it. The
 * picture is CONTAINED and must stay contained, because covering the box is
 * what threw the house away the time before; so the ground is filled instead.
 *
 * The title half is the same list disagreeing with itself: where two packages
 * share a lot the source says so in the address (`[3 Bed · 140 m²]`), and
 * printed verbatim that put the bed count on a card that already draws it as
 * an icon and an unlabelled `140 m²` two lines above `286 m² land`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CARD_PICTURE_ASPECT, CARD_PICTURE_GROUND_FLOOR,
  cardPictureGroundShare, cardPictureNeedsGround,
  describesConfigurationOnly, homeSizeDisplay, homeSizeLabel, sizeFromConfiguration,
  stockItemTitle,
} from '../builderStock';

/** The shapes actually live, with the share of the box each leaves bare. */
const LIVE_SHAPES: Array<{ w: number; h: number; cards: number; bare: number }> = [
  { w: 3000, h: 1875, cards: 6, bare: 0 },
  { w: 2000, h: 1250, cards: 3, bare: 0 },
  { w: 1000, h: 625, cards: 2, bare: 0 },
  { w: 1700, h: 956, cards: 7, bare: 0.1 },
  { w: 480, h: 339, cards: 2, bare: 0.115 },
  { w: 2481, h: 1208, cards: 3, bare: 0.221 },
  { w: 2500, h: 2800, cards: 2, bare: 0.442 },
  { w: 2480, h: 692, cards: 2, bare: 0.554 },
];

describe('cardPictureGroundShare', () => {
  it('reproduces the measured share for every shape live on the marketplace', () => {
    for (const shape of LIVE_SHAPES) {
      expect(cardPictureGroundShare(shape.w, shape.h)).toBeCloseTo(shape.bare, 3);
    }
  });

  it('is symmetric: a portrait and a strip are one problem seen from either side', () => {
    // A shape at ratio r leaves what the shape at BOX² / r leaves — so the
    // 0.893 portrait and the 2.866 strip are the same 44% of bare ground.
    const mirror = (ratio: number) => (CARD_PICTURE_ASPECT * CARD_PICTURE_ASPECT) / ratio;
    for (const ratio of [0.625, 0.893, 1.416, 2.054, 3.584]) {
      expect(cardPictureGroundShare(mirror(ratio) * 1000, 1000))
        .toBeCloseTo(cardPictureGroundShare(ratio * 1000, 1000), 6);
    }
  });

  it('reads zero for a picture whose dimensions cannot be measured', () => {
    for (const [w, h] of [[0, 0], [1600, 0], [0, 1000], [-4, 3], [NaN, 10], [10, Infinity]]) {
      expect(cardPictureGroundShare(w, h)).toBe(0);
    }
  });
});

describe('cardPictureNeedsGround', () => {
  it('leaves the eleven cards that already fill the box alone', () => {
    const filling = LIVE_SHAPES.filter((shape) => shape.bare === 0);
    expect(filling.reduce((sum, shape) => sum + shape.cards, 0)).toBe(11);
    for (const shape of filling) expect(cardPictureNeedsGround(shape.w, shape.h)).toBe(false);
  });

  it('fills the ground on the sixteen that do not', () => {
    const banding = LIVE_SHAPES.filter((shape) => shape.bare > 0);
    expect(banding.reduce((sum, shape) => sum + shape.cards, 0)).toBe(16);
    for (const shape of banding) expect(cardPictureNeedsGround(shape.w, shape.h)).toBe(true);
  });

  it('keeps the plain box for a picture it could not measure', () => {
    // Never a blur nobody asked for: the fill improves a sound card, so the
    // unmeasured case has to fail to the card as it was.
    expect(cardPictureNeedsGround(0, 0)).toBe(false);
    expect(cardPictureNeedsGround(NaN, NaN)).toBe(false);
  });

  it('sets the floor under the 1.778 group and above nothing at all', () => {
    expect(CARD_PICTURE_GROUND_FLOOR).toBeLessThanOrEqual(0.1);
    expect(CARD_PICTURE_GROUND_FLOOR).toBeGreaterThan(0);
  });
});

describe('the box the arithmetic assumes is the box the card draws', () => {
  /*
   * `aspect-[16/10]` cannot be composed from a variable without defeating
   * Tailwind's class extractor, so the number and the class are written
   * separately. This is the only thing holding them together.
   */
  it('pins CARD_PICTURE_ASPECT to the class BuilderStockTab renders', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/listings/BuilderStockTab.tsx'), 'utf8',
    );
    const classes = source.match(/aspect-\[(\d+)\/(\d+)\]/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const drawn of classes) {
      const [, w, h] = /aspect-\[(\d+)\/(\d+)\]/.exec(drawn)!;
      expect(Number(w) / Number(h)).toBeCloseTo(CARD_PICTURE_ASPECT, 6);
    }
  });

  it('unmounts the ground with the picture it belongs to', () => {
    /*
     * The dim layer and the blurred picture under it are one treatment. Gated
     * separately, a picture that BROKE after being measured took the blur away
     * and left the scrim dimming an empty box.
     */
    const source = readFileSync(
      join(process.cwd(), 'src/components/listings/BuilderStockTab.tsx'), 'utf8',
    );
    const guard = 'signedUrl && !broken && needsGround';
    expect(source.split(guard).length - 1).toBe(2);
  });

  it('keeps the photograph contained, never covered', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/listings/BuilderStockTab.tsx'), 'utf8',
    );
    // The ground layer covers deliberately — it is decorative and must fill.
    // The photograph itself never may: covering is what cropped the house.
    const photograph = source.slice(source.indexOf('alt={STOCK_IMAGE_STAGE_LABELS'));
    expect(photograph.slice(0, 400)).toContain('object-contain');
    expect(photograph.slice(0, 400)).not.toContain('object-cover');
  });
});

describe('describesConfigurationOnly', () => {
  it('recognises a list’s own disambiguator as data rather than a name', () => {
    expect(describesConfigurationOnly('3 Bed · 140 m²')).toBe(true);
    expect(describesConfigurationOnly('4 Bed · 154 m²')).toBe(true);
    expect(describesConfigurationOnly('4 bed, 2 bath, 2 car')).toBe(true);
    expect(describesConfigurationOnly('3 bedrooms - 2 bathrooms')).toBe(true);
    expect(describesConfigurationOnly('220 sqm')).toBe(true);
    expect(describesConfigurationOnly('154m2 / 2 car spaces')).toBe(true);
  });

  it('treats one unrecognised word as a NAME, because losing a real name is worse', () => {
    expect(describesConfigurationOnly('Ilya 15')).toBe(false);
    expect(describesConfigurationOnly('Aspire 22 · 4 Bed')).toBe(false);
    expect(describesConfigurationOnly('Facade B')).toBe(false);
    expect(describesConfigurationOnly('Sanctuary 28 MkII')).toBe(false);
    // A bare number names nothing measurable either — not configuration.
    expect(describesConfigurationOnly('15')).toBe(false);
    expect(describesConfigurationOnly('')).toBe(false);
    expect(describesConfigurationOnly('   ')).toBe(false);
  });

  it('does not mistake a word that merely starts with a token', () => {
    expect(describesConfigurationOnly('2 Bedrock')).toBe(false);
    expect(describesConfigurationOnly('4 Carlisle')).toBe(false);
  });
});

describe('sizeFromConfiguration / homeSizeLabel', () => {
  it('reads the house size a configuration annotation states', () => {
    expect(sizeFromConfiguration('3 Bed · 140 m²')).toBe(140);
    expect(sizeFromConfiguration('4 Bed · 154m2')).toBe(154);
    expect(sizeFromConfiguration('220 sqm')).toBe(220);
    expect(sizeFromConfiguration('4 Bed · 2 Bath')).toBeNull();
  });

  it('labels a size and refuses anything that is not one', () => {
    expect(homeSizeLabel(154)).toBe('154 m² home');
    expect(homeSizeLabel(null)).toBeNull();
    expect(homeSizeLabel(undefined)).toBeNull();
    expect(homeSizeLabel(0)).toBeNull();
    expect(homeSizeLabel(-12)).toBeNull();
  });
});

describe('homeSizeDisplay — rounded to show, never to store', () => {
  /*
   * Builders quote a plan to the centimetre, so two decimals beside a whole
   * `563 m² land` is noise on a card with one line for both. The rounding is
   * a property of the DISPLAY: nothing here writes, and `building_size_sqm`
   * keeps every digit for the contract, the report and the export.
   */
  it('rounds the seven live sizes that carry decimals', () => {
    const live: Array<[number, number]> = [
      [179.82, 180], [190.38, 190], [174.65, 175], [173.84, 174],
      [168.1, 168], [167.3, 167], [161.54, 162], [172.84, 173],
      [121.84, 122], [139.52, 140], [175.28, 175],
    ];
    for (const [stored, shown] of live) {
      expect(homeSizeDisplay(stored)).toBe(shown);
      expect(homeSizeLabel(stored)).toBe(`${shown} m² home`);
    }
  });

  it('leaves a whole size exactly as it is', () => {
    for (const whole of [140, 154, 141, 178, 184, 207, 232, 235, 243, 295]) {
      expect(homeSizeDisplay(whole)).toBe(whole);
    }
  });

  it('rounds half away from zero, as a reader would', () => {
    expect(homeSizeDisplay(140.5)).toBe(141);
    expect(homeSizeDisplay(140.49)).toBe(140);
  });

  it('refuses anything that is not a size', () => {
    expect(homeSizeDisplay(null)).toBeNull();
    expect(homeSizeDisplay(undefined)).toBeNull();
    expect(homeSizeDisplay(0)).toBeNull();
    expect(homeSizeDisplay(-12)).toBeNull();
    expect(homeSizeDisplay(NaN)).toBeNull();
    expect(homeSizeDisplay(Infinity)).toBeNull();
  });

  it('says nothing rather than that a house has no floor area', () => {
    // 0.4 is a bad record; `0 m² home` on a card would be a claim about a
    // house, which is worse than an absent line.
    expect(homeSizeDisplay(0.4)).toBeNull();
    expect(homeSizeLabel(0.4)).toBeNull();
  });

  it('is the only reading the stats row takes — never the raw column', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/listings/BuilderStockTab.tsx'), 'utf8',
    );
    expect(source).toContain('homeSizeDisplay(item.building_size_sqm)');
    // Rendering the column directly is what printed `179.82 m² home`.
    expect(source).not.toMatch(/\{item\.building_size_sqm\}/);
  });
});

/** The six cards in the reported screenshot, as the list actually holds them. */
function item(over: Partial<Parameters<typeof stockItemTitle>[0]>) {
  return {
    unit_number: null, lot_number: null, address_line: null,
    development_name: null, project_name: null, external_reference: null,
    building_size_sqm: null,
    ...over,
  } as Parameters<typeof stockItemTitle>[0];
}

describe('stockItemTitle — the reported cards', () => {
  it('tells two packages on one lot apart by the house, labelled', () => {
    expect(stockItemTitle(item({
      address_line: 'Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [4 Bed · 154 m²]',
      building_size_sqm: 154,
    }))).toBe('Lot 60941, Cloverton Estate · 154 m² home');

    expect(stockItemTitle(item({
      address_line: 'Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [3 Bed · 140 m²]',
      building_size_sqm: 140,
    }))).toBe('Lot 60941, Cloverton Estate · 140 m² home');
  });

  it('leaves the cards that were already right exactly as they were', () => {
    expect(stockItemTitle(item({
      address_line: 'Lot 60416 Russula St, Beveridge VIC 3753 (141 m2)',
      building_size_sqm: 141,
    }))).toBe('Lot 60416, Russula Street');

    expect(stockItemTitle(item({
      address_line: 'Lot 843 - Verve Estate, Clyde VIC 3978', lot_number: '843',
    }))).toBe('Lot 843, Verve Estate');
  });

  it('keeps a real design name, which is the better differentiator', () => {
    expect(stockItemTitle(item({
      address_line: 'Lot 22 - Aria Estate, Tarneit VIC 3029 [Ilya 15]',
      building_size_sqm: 141,
    }))).toBe('Lot 22, Aria Estate · Ilya 15');
  });

  it('falls back to the size the annotation states when the column has none', () => {
    expect(stockItemTitle(item({
      address_line: 'Lot 7 - Some Estate, Clyde VIC 3978 [3 Bed · 140 m²]',
    }))).toBe('Lot 7, Some Estate · 140 m² home');
  });

  it('drops the suffix entirely rather than print a bed count the card draws', () => {
    expect(stockItemTitle(item({
      address_line: 'Lot 9 - Some Estate, Clyde VIC 3978 [4 Bed · 2 Bath]',
    }))).toBe('Lot 9, Some Estate');
  });
});
