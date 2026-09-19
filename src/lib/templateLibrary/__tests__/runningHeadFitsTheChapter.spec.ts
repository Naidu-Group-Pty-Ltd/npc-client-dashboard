/**
 * The running head says which chapter a page is in — on every master.
 *
 * ## Twenty-nine pages that said the same thing
 *
 * v15 made the running head name the chapter rather than the part. It reached
 * eleven of the fifty masters. `furniture()` branches on `navigation_style`:
 * a RAILED family draws the part as an eyebrow and the section beneath it, and
 * a RUNNING-HEAD family draws the part and **discards the section argument
 * entirely**. So the chapter binding was composed, published and passed in on
 * all fifty, and drawn on eleven.
 *
 * On the 42 Patya Circuit Compass of 19 September 2026, 29 of 36 pages carried
 * the identical head `Part 05 · Report`. The body IS one part — that is right,
 * and renumbering it would be wrong — but a reader thirty pages in has no way
 * to tell the zoning chapter from the transport one.
 *
 * ## What changed, and what deliberately did not
 *
 * `furniture()` takes an optional `headMarker`, which only the running-head
 * branch reads. The Compass passes `Part NN · {{narrative.chapters.i}}` on its
 * report pages. Everything else — the railed branch, the other nine formats,
 * the Compass's own non-report pages — passes nothing and is byte-identical,
 * which is what keeps a 450-master blast radius off a 50-master fix.
 *
 * ## What this pins
 *
 * That the marker is drawn where it was being discarded, and that the longest
 * one the product can compose still fits the two lines `runningHead` reserves
 * for it. `CHAPTER_MAX_CHARS` is 64 and `runningChapters` leaves anything
 * longer to the document-name fallback, so the worst case is exactly
 * `'Part NN · '.length + 64` — measured, not assumed, because the marker sits
 * in 34% of the measure and the rule beneath it does not move.
 */
import { describe, expect, it } from 'vitest';
import {
  INVESTMENT_COMPASS_TEMPLATES,
} from '../../../../scripts/template-library/investmentCompass/templates';
import {
  MONO_ADVANCE,
} from '../../../../scripts/template-library/investmentCompass/blocks';
import {
  CHAPTER_MAX_CHARS,
} from '../../../../supabase/functions/_shared/reports/runningChapters.pure';

interface Marker { template: string; size: number; width: number; body: string }

/** The report pages of every master, split by which furniture they drew. */
function reportFurniture() {
  const railed: string[] = [];
  const markers: Marker[] = [];
  for (const t of INVESTMENT_COMPASS_TEMPLATES as Record<string, any>[]) {
    const schema = t.schema ?? t.page_schema ?? t;
    const name = String(t.name ?? t.key);
    for (const page of (schema.pages ?? []) as Record<string, any>[]) {
      // The first body page. The continuation pages repeat its furniture.
      if (page.name !== 'The report') continue;
      for (const b of (page.blocks ?? []) as Record<string, any>[]) {
        if (b.name === 'Rail marker') railed.push(name);
        if (b.name === 'Part marker') {
          markers.push({ template: name, size: b.props.bodySize, width: b.props.width, body: String(b.props.body) });
        }
      }
    }
  }
  return { railed, markers };
}

const { railed, markers } = reportFurniture();

/** The one line-count for the marker, mirroring `runningHeadMarkerLines`. */
const markerLines = (chars: number, m: Marker) =>
  Math.max(1, Math.ceil(chars / Math.max(1, Math.floor(m.width / (m.size * MONO_ADVANCE)))));

describe('every master tells the reader which chapter they are in', () => {
  it('covers all fifty, by one route or the other', () => {
    expect(railed.length + markers.length).toBe(50);
    // Both routes exist — if either count went to zero the assertions about it
    // below would be vacuous.
    expect(railed.length).toBeGreaterThan(0);
    expect(markers.length).toBeGreaterThan(0);
  });

  it('names the chapter on every running-head master', () => {
    const silent = markers.filter((m) => !m.body.includes('narrative.chapters'));
    expect(
      silent.map((m) => `${m.template}: ${m.body}`),
      'running-head masters whose report pages still draw only the part',
    ).toEqual([]);
  });

  it('keeps the part number, which is what orients the reader', () => {
    const unnumbered = markers.filter((m) => !/^Part \d\d · /.test(m.body));
    expect(unnumbered.map((m) => `${m.template}: ${m.body}`)).toEqual([]);
  });

  it('fits the longest chapter into the two lines the rule reserves', () => {
    // `Part NN · ` plus the longest heading `runningChapters` will pass
    // through. Anything longer is already the document-name fallback, which is
    // shorter than this.
    const worst = 'Part 05 · '.length + CHAPTER_MAX_CHARS;
    expect(worst).toBe(74);
    const over = markers
      .filter((m) => markerLines(worst, m) > 2)
      .map((m) => `${m.template}: ${markerLines(worst, m)} lines at ${m.size}pt in ${m.width}pt`);
    expect(over, 'markers that would strike the rule beneath them').toEqual([]);
  });
});
