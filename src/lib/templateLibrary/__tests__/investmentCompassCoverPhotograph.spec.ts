/**
 * The report's lead photograph on the covers the catalogue drew without one.
 *
 * Five of the fifty Investment masters were designed around photographs. The
 * other forty-five had nowhere to put one, so a report holding the property's
 * own photographs printed none of them on its cover. Since seed v21 the
 * cover's ground decides (`withCoverPhotograph`):
 *   - a FIELD cover takes it behind the whole sheet, under two passes of the
 *     field's own scrim, so the small type stays at the print floor over a
 *     white facade;
 *   - a BANDED cover takes it inside the band, under the same two passes;
 *   - a PAPER cover is left as drawn.
 *
 * Two promises are pinned here, because breaking either one would be seen by
 * a client:
 *   - Without a photograph, a cover draws exactly what it drew before. Most
 *     reports have no photograph, and every photo block is conditional.
 *   - Beside a photograph, nothing on the cover moves. The photograph is a
 *     layer under the type, never a block in its flow.
 */
import { describe, expect, it } from 'vitest';
import { renderTemplateToHtml } from '@/lib/reportTemplate/htmlRenderer';
import { INVESTMENT_COMPASS_TEMPLATES } from '../../../../scripts/template-library/investmentCompass/templates';
import { COVER_BAND_HEIGHT, PAGE } from '../../../../scripts/template-library/investmentCompass/blocks';
import { familyByKey, resolveManifest } from '../../../../scripts/template-library/investmentCompass/family';
import { coverPlan, imageSlotPlan } from '../../../../scripts/template-library/investmentCompass/resolvers';
import { SAMPLE_REPORT_DATA } from '../sampleReportData';

interface SchemaBlock { id: string; type: string; name?: string; conditional?: string; props: Record<string, unknown> }
interface Master {
  name: string;
  schema: { pages: Array<{ blocks: SchemaBlock[] }> };
  designMeta: { familyKey: string; templateCode: string };
}

const MASTERS = INVESTMENT_COMPASS_TEMPLATES as unknown as Master[];
const LEAD_PHOTOGRAPH = 'property && property.images && property.images[0]';

/** How the catalogue drew a master's cover: its ground, and whether it was photographic already. */
function coverOf(master: Master) {
  const family = familyByKey(master.designMeta.familyKey)!;
  const variant = family.variants.find((v) => v.code === master.designMeta.templateCode)!;
  const manifest = resolveManifest(family, variant);
  const slots = imageSlotPlan(manifest.image_slots);
  return {
    ground: coverPlan(manifest.cover_overlay).ground,
    designedWithPhotographs: slots.coverHero || slots.plates.length > 0,
  };
}

const bindsLeadPhotograph = (b: SchemaBlock) => b.conditional === LEAD_PHOTOGRAPH;
const coverBlocks = (master: Master) => master.schema.pages[0].blocks;
const withoutPhotograph = (() => {
  const property = { ...(SAMPLE_REPORT_DATA as { property: Record<string, unknown> }).property };
  delete property.images;
  return { ...SAMPLE_REPORT_DATA, property };
})();

/** Every absolutely positioned box on the rendered cover, in document order. */
function coverPositions(schema: unknown, data: Record<string, unknown>): string[] {
  const html = renderTemplateToHtml(schema as never, { data }).html;
  const start = html.indexOf('class="tpl-page tpl-page-0"');
  const end = html.indexOf('class="tpl-page tpl-page-1"', start + 1);
  return [...html.slice(start, end).matchAll(/position:absolute;left:([\d.]+)pt;(top|bottom):([\d.]+)pt;/g)]
    .map((m) => `${m[2]}:${m[3]}@${m[1]}`);
}

const FIELD = MASTERS.filter((m) => !coverOf(m).designedWithPhotographs && coverOf(m).ground === 'field');
const BANDED = MASTERS.filter((m) => !coverOf(m).designedWithPhotographs && coverOf(m).ground === 'band');
const PAPER = MASTERS.filter((m) => !coverOf(m).designedWithPhotographs && coverOf(m).ground === 'paper');
const PHOTOGRAPHIC = MASTERS.filter((m) => coverOf(m).designedWithPhotographs);

describe('which covers carry the lead photograph', () => {
  it('the forty-five covers drawn without photographs split 16 field, 18 banded and 11 paper', () => {
    expect(FIELD).toHaveLength(16);
    expect(BANDED).toHaveLength(18);
    expect(PAPER).toHaveLength(11);
    expect(PHOTOGRAPHIC).toHaveLength(5);
  });

  it('every field and banded cover now carries it, and the paper covers do not', () => {
    for (const m of [...FIELD, ...BANDED]) {
      // The photograph and two passes of the scrim.
      expect(coverBlocks(m).filter(bindsLeadPhotograph), m.name).toHaveLength(3);
    }
    for (const m of PAPER) {
      expect(JSON.stringify(coverBlocks(m)), m.name).not.toContain('property.images');
    }
  });

  it('the five masters designed around photographs gain nothing', () => {
    for (const m of PHOTOGRAPHIC) {
      expect(coverBlocks(m).some((b) => b.name === 'Band scrim'), m.name).toBe(false);
      // Atelier, Atelier Plate and Grand Folio already carry exactly one cover
      // photograph; Frontispiece and Elevation carry plates and no cover one.
      const expected = ['le-01', 'le-02', 'le-03'].includes(m.designMeta.templateCode) ? 2 : 0;
      expect(coverBlocks(m).filter(bindsLeadPhotograph), m.name).toHaveLength(expected);
    }
  });
});

describe('where the photograph sits', () => {
  it('on a field cover: under everything, the whole sheet, beneath two passes of the field\'s own scrim', () => {
    for (const m of FIELD) {
      const [image, scrim, second] = coverBlocks(m);
      expect(image.type, m.name).toBe('image');
      expect(image.props).toMatchObject({
        src: '{{property.images.0}}', fit: 'cover', placeholder: false,
        x: 0, y: 0, width: PAGE.width, height: PAGE.height,
      });
      expect(scrim).toMatchObject({ type: 'hero', name: 'Cover scrim' });
      expect(second).toMatchObject({ type: 'hero', name: 'Cover scrim, second pass' });
      // The field's own colour at the hero's tint, never a literal colour, and never opaque.
      for (const pass of [scrim, second]) {
        expect(pass.props).toMatchObject({ tint: 'token:bg', x: 0, y: 0, width: PAGE.width, height: PAGE.height });
        expect(pass.props.bg).toBeUndefined();
        expect(bindsLeadPhotograph(pass)).toBe(true);
      }
    }
  });

  it('on a banded cover: inside the band, above its colour and beneath its type', () => {
    for (const m of BANDED) {
      const blocks = coverBlocks(m);
      const band = blocks.findIndex((b) => b.name === 'Cover band');
      expect(band, m.name).toBeGreaterThanOrEqual(0);
      expect(blocks[band].props.height).toBe(COVER_BAND_HEIGHT);
      const [image, scrim, second] = [blocks[band + 1], blocks[band + 2], blocks[band + 3]];
      expect(image.props).toMatchObject({
        src: '{{property.images.0}}', fit: 'cover', placeholder: false,
        x: 0, y: 0, width: PAGE.width, height: COVER_BAND_HEIGHT,
      });
      expect(scrim).toMatchObject({ type: 'hero', name: 'Band scrim' });
      expect(second).toMatchObject({ type: 'hero', name: 'Band scrim, second pass' });
      for (const pass of [scrim, second]) {
        expect(pass.props).toMatchObject({ tint: 'token:bg', x: 0, y: 0, width: PAGE.width, height: COVER_BAND_HEIGHT });
        expect(pass.props.bg).toBeUndefined();
      }
      expect([image, scrim, second].every(bindsLeadPhotograph)).toBe(true);
      // Nothing that paints is set before the band: the photograph is the
      // second thing drawn, so every word of the head sits on top of it.
      expect(blocks.slice(0, band).filter(bindsLeadPhotograph)).toEqual([]);
    }
  });
});

describe('PRESERVATION — a report without a photograph draws exactly the cover it drew before', () => {
  for (const m of [...FIELD, ...BANDED]) {
    it(`${m.designMeta.templateCode} ${m.name}`, () => {
      const stripped = {
        ...m.schema,
        pages: m.schema.pages.map((p, i) => (i === 0
          ? { ...p, blocks: p.blocks.filter((b) => !bindsLeadPhotograph(b)) }
          : p)),
      };
      const html = (schema: unknown) => renderTemplateToHtml(schema as never, { data: withoutPhotograph }).html;
      expect(html(m.schema)).toBe(html(stripped));
    });
  }
});

describe('beside a photograph, nothing on the cover moves', () => {
  for (const m of [...FIELD, ...BANDED]) {
    it(`${m.designMeta.templateCode} ${m.name}`, () => {
      const withPhotograph = coverPositions(m.schema, SAMPLE_REPORT_DATA);
      const without = coverPositions(m.schema, withoutPhotograph);
      // The photograph and its two scrims are three boxes at the head of the
      // sheet; every other box stands exactly where it stands without them.
      expect(withPhotograph.length - without.length).toBe(3);
      const photographAt = coverOf(m).ground === 'field' ? 0 : 1;
      expect(withPhotograph.slice(photographAt, photographAt + 3)).toEqual(['top:0@0', 'top:0@0', 'top:0@0']);
      expect([...withPhotograph.slice(0, photographAt), ...withPhotograph.slice(photographAt + 3)]).toEqual(without);
    });
  }

  it('the photograph reaches the page it is bound on', () => {
    const [lead] = (SAMPLE_REPORT_DATA as { property: { images: string[] } }).property.images;
    for (const m of [...FIELD, ...BANDED]) {
      const html = renderTemplateToHtml(m.schema as never, { data: SAMPLE_REPORT_DATA }).html;
      const start = html.indexOf('class="tpl-page tpl-page-0"');
      const end = html.indexOf('class="tpl-page tpl-page-1"', start + 1);
      expect(html.slice(start, end), m.name).toContain(lead);
    }
  });
});
