/**
 * A chosen template that cannot carry the report is composed, never shipped
 * near-empty.
 *
 * Measured defect, 15 Sep 2026: the library's "First-Home Buyer Report" was
 * chosen for an Investment report and drew five pages — a cover reading
 * "Prepared for" with nothing after it, three content pages carrying only
 * their headings, and a disclaimer — because every binding on it
 * (`client.deposit`, `finance.capacity`, `grants.fhog`, `steps.0`) is a
 * sample-preset vocabulary no adapter publishes. Nothing measured that.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyPage,
  measureBindingCoverage,
  pathsInBlock,
  pathsInConditional,
  pathsInString,
} from '../templateBindingCoverage.pure';
import { composeTemplateWithDonor, mergeTokens } from '../templateComposition.pure';

const tokens = (colors: Record<string, string>, fonts: Record<string, string>) => ({
  colors, fonts, radii: { sm: 0, md: 0, lg: 2 }, spacing: { gutter: 22, padding: 24, sectionGap: 30 },
  typeScale: { body: 9.75, cover: 44, eyebrow: 8, heading: 21 }, fontFaces: [],
});

/** The shape the seeded First-Home Buyer Report has, reduced to what matters. */
const firstHomeBuyer = {
  name: 'First-Home Buyer Report',
  version: 1,
  tokens: tokens({ bg: 'cocoa', primary: 'gold', ink: 'ink-brown' }, { body: 'Inter, sans-serif', heading: 'Fraunces, serif' }),
  pages: [
    { id: 'seed-page-2', name: 'Cover', blocks: [{ id: 'c', type: 'cover', props: { mark: '{{org.markMono}}', subtitle: 'Prepared for {{client.name}}', title: 'Your First Property' } }] },
    { id: 'seed-page-7', name: 'What you can do', blocks: [
      { id: 't', type: 'text-block', props: { heading: 'What you can do', body: 'Based on the deposit…' } },
      { id: 'k', type: 'kpi-grid', props: { items: [{ label: 'Deposit', value: '{{client.deposit | currency}}' }, { label: 'Capacity', value: '{{finance.capacity | currency}}' }] } },
      { id: 'f', type: 'footer', props: { text: '{{property.address}} · {{client.name}}' } },
      { id: 'n', type: 'page-number', props: {} },
    ] },
    { id: 'seed-page-d', name: 'The real cost', blocks: [
      { id: 'b', type: 'chart-bar', props: { dataPath: 'finance.rateScenarios', title: 'If rates move' } },
      { id: 'f2', type: 'footer', props: { text: '{{property.address}}' } },
    ] },
    { id: 'seed-page-n', name: 'Important information', blocks: [{ id: 'd', type: 'disclaimer', props: { abn: '{{org.abn}}', companyName: '{{org.name}}' } }] },
  ],
};

/** A family master, reduced: cover, contents, two narrative pages, method, disclaimer. */
const master = {
  name: 'Luxury Editorial — Frontispiece · Midnight Editorial',
  version: 1,
  tokens: tokens({ bg: 'midnight', primary: 'brass', ink: 'parchment', info: 'sky' }, { body: 'Playfair Display, serif', heading: 'Cinzel, serif' }),
  slots: { runningHead: { id: 'rh', type: 'text-block', props: { body: '{{report.address}}' } } },
  pageMasters: { std: { id: 'std', name: 'Standard', margins: { top: 36, right: 36, bottom: 36, left: 36 } } },
  pages: [
    // The masters build their covers on a hero plate and text blocks — no `cover` block.
    { id: 'm-cover', name: 'Cover', blocks: [
      { id: 'mh', type: 'hero', props: { src: '{{report.heroImage}}' } },
      { id: 'mt', type: 'text-block', props: { heading: '{{report.address}}', body: '{{org.name}}' } },
    ] },
    { id: 'm-contents', name: 'Contents', blocks: [{ id: 'toc', type: 'toc', props: {} }, { id: 'rh', type: 'text-block', props: { body: '{{report.address}}' } }] },
    { id: 'm-narr-0', name: 'The report', conditional: 'narrative && narrative.source', blocks: [{ id: 'md0', type: 'markdown-block', props: { source: '{{narrative.source}}', pageIndex: 0 } }] },
    { id: 'm-narr-1', name: 'The report', conditional: 'narrative && narrative.pages > 1', blocks: [{ id: 'md1', type: 'markdown-block', props: { source: '{{narrative.source}}', pageIndex: 1 } }] },
    { id: 'm-method', name: 'Sources and methodology', blocks: [{ id: 'dl', type: 'definition-list', props: { items: [{ term: 'Prepared by', definition: '{{org.name}}' }, { term: 'Property', definition: '{{property.address}}' }] } }] },
    { id: 'm-disc', name: 'Important information', blocks: [{ id: 'md', type: 'disclaimer', props: { abn: '{{org.abn}}' } }] },
  ],
};

/** What the Investment adapter publishes for a real report, reduced. */
const investmentData = {
  report: { id: 'r1', type: 'investment', address: '291 Stone Mason Drive, Kellyville NSW 2155' },
  property: { address: '291 Stone Mason Drive, Kellyville NSW 2155', bedrooms: 3 },
  narrative: { source: '# Executive Verdict\n\nKellyville offers…', pages: 22 },
  org: { name: 'Naidu Property Consulting Services', abn: '50 684 555 771', mark: 'data:image/svg+xml;utf8,x', markMono: 'data:image/svg+xml;utf8,y' },
};

describe('binding paths are read the way the resolver reads them', () => {
  it('takes the head of each binding and skips computed forms', () => {
    expect(pathsInString('{{client.deposit | currency}} and {{finance.capacity}}')).toEqual(['client.deposit', 'finance.capacity']);
    expect(pathsInString('{{= price * 0.06 | currency}} {{@netYield}}')).toEqual([]);
    expect(pathsInString('no bindings here')).toEqual([]);
  });

  it('reads a bare data path on a chart prop and dotted paths in a conditional', () => {
    expect(pathsInBlock({ type: 'chart-bar', props: { dataPath: 'finance.rateScenarios', title: 'x' } })).toEqual(['finance.rateScenarios']);
    expect(pathsInConditional('narrative && narrative.pages > 3')).toEqual(['narrative.pages']);
  });

  it('classifies a page by what it is for', () => {
    expect(classifyPage(firstHomeBuyer.pages[0])).toBe('cover');
    expect(classifyPage(firstHomeBuyer.pages[1])).toBe('content');
    expect(classifyPage(firstHomeBuyer.pages[3])).toBe('closing');
    expect(classifyPage({ name: 'x', blocks: [{ type: 'footer', props: {} }, { type: 'page-number', props: {} }] })).toBe('furniture');
  });

  it('recognises a master cover built on a hero, and not a plate page further in', () => {
    expect(classifyPage(master.pages[0], 0)).toBe('cover');
    expect(classifyPage({ name: 'Plate 01', blocks: [{ type: 'hero', props: {} }] }, 3)).toBe('content');
    expect(classifyPage({ name: 'Cover', blocks: [{ type: 'text-block', props: {} }] }, 0)).toBe('cover');
    expect(classifyPage({ name: 'Back cover', blocks: [{ type: 'text-block', props: {} }] }, 9)).toBe('closing');
  });
});

describe('measureBindingCoverage', () => {
  it('finds that the First-Home Buyer template carries nothing of an Investment report', () => {
    const cov = measureBindingCoverage(firstHomeBuyer, investmentData);
    expect(cov.carriesBody).toBe(false);
    // The address in a footer is furniture; the cover's client name never resolves.
    expect(cov.pages.map((p) => [p.kind, p.contentResolved.length])).toEqual([
      ['cover', 0], ['content', 0], ['content', 0], ['closing', 0],
    ]);
    expect(cov.resolved).toEqual(['org.markMono', 'property.address', 'org.abn', 'org.name']);
    expect(cov.bound).toContain('client.deposit');
    expect(cov.coverage).toBeLessThanOrEqual(0.5);
    expect(cov.needsComposition).toBe(true);
    expect(cov.pages.map((p) => p.blank)).toEqual([false, true, true, false]);
  });

  it('finds that a family master carries the body through its narrative pages', () => {
    const cov = measureBindingCoverage(master, investmentData);
    expect(cov.carriesBody).toBe(true);
    expect(cov.pages.filter((p) => p.carriesBody).map((p) => p.name)).toEqual(['The report', 'The report']);
    expect(cov.pages.map((p) => p.kind)).toEqual(['cover', 'content', 'content', 'content', 'content', 'closing']);
    expect(cov.needsComposition).toBe(false);
  });

  it('never counts a value that is present but empty as resolved', () => {
    const cov = measureBindingCoverage(firstHomeBuyer, { ...investmentData, client: { name: '   ' } });
    expect(cov.resolved).not.toContain('client.name');
  });
});

describe('composeTemplateWithDonor', () => {
  it('keeps the chosen cover and closing pages, drops what resolves nothing, and carries the donor body between them', () => {
    const result = composeTemplateWithDonor(firstHomeBuyer, master, investmentData)!;
    expect(result).not.toBeNull();
    expect(result.kept).toEqual([{ name: 'Cover', kind: 'cover' }, { name: 'Important information', kind: 'closing' }]);
    expect(result.dropped.map((p) => p.name)).toEqual(['What you can do', 'The real cost']);
    const names = (result.schema.pages as Array<{ id: string; name: string }>).map((p) => `${p.id}:${p.name}`);
    expect(names).toEqual([
      'seed-page-2:Cover',
      'm-contents:Contents', 'm-narr-0:The report', 'm-narr-1:The report', 'm-method:Sources and methodology',
      'seed-page-n:Important information',
    ]);
    expect(result.bodyPages).toBe(4);
  });

  it('draws the body in the chosen palette, with the donor filling any token the chosen template does not declare', () => {
    const result = composeTemplateWithDonor(firstHomeBuyer, master, investmentData)!;
    const t = result.schema.tokens as { colors: Record<string, string>; fonts: Record<string, string> };
    expect(t.colors.primary).toBe('gold');
    expect(t.colors.bg).toBe('cocoa');
    expect(t.colors.info).toBe('sky');
    expect(t.fonts.heading).toBe('Fraunces, serif');
    expect(result.schema.name).toBe('First-Home Buyer Report');
    // Donor-level structure travels with the donor's pages.
    expect(Object.keys(result.schema.slots as object)).toEqual(['runningHead']);
    expect(Object.keys(result.schema.pageMasters as object)).toEqual(['std']);
  });

  it('leaves a kept label unprinted when everything it binds is absent, and the donor pages untouched', () => {
    const result = composeTemplateWithDonor(firstHomeBuyer, master, investmentData)!;
    const pages = result.schema.pages as Array<{ id: string; blocks: Array<{ props: Record<string, unknown> }> }>;
    const cover = pages.find((p) => p.id === 'seed-page-2')!;
    // "Prepared for {{client.name}}" binds only an absence: blank, never "Prepared for".
    expect(cover.blocks[0].props.subtitle).toBe('');
    expect(cover.blocks[0].props.title).toBe('Your First Property');
    expect(cover.blocks[0].props.mark).toBe('{{org.markMono}}');
    const donorNarrative = pages.find((p) => p.id === 'm-narr-0')!;
    expect(donorNarrative.blocks[0].props.source).toBe('{{narrative.source}}');
  });

  it('keeps the donor cover when the chosen template has none, and the donor closing page when it has none', () => {
    const coverless = { ...firstHomeBuyer, pages: firstHomeBuyer.pages.slice(1, 3) };
    const result = composeTemplateWithDonor(coverless, master, investmentData)!;
    const names = (result.schema.pages as Array<{ name: string }>).map((p) => p.name);
    expect(names[0]).toBe('Cover');
    expect(names[names.length - 1]).toBe('Important information');
    expect(result.kept).toEqual([]);
  });

  it('composes nothing when the chosen template resolves content of its own, binds nothing at all, or the donor resolves nothing', () => {
    expect(composeTemplateWithDonor(master, master, investmentData)).toBeNull();
    expect(composeTemplateWithDonor(firstHomeBuyer, firstHomeBuyer, investmentData)).toBeNull();
    const brochure = { ...firstHomeBuyer, pages: [firstHomeBuyer.pages[0], { id: 'static', name: 'About us', blocks: [{ id: 's', type: 'text-block', props: { heading: 'About us', body: 'Static prose.' } }] }] };
    expect(measureBindingCoverage(brochure, investmentData).needsComposition).toBe(false);
    expect(composeTemplateWithDonor(brochure, master, investmentData)).toBeNull();
  });

  it('is not the rule for a template that resolves even one content field — that document is the author\'s', () => {
    const snapshot = {
      ...firstHomeBuyer,
      pages: [firstHomeBuyer.pages[0], { id: 'snap', name: 'Snapshot', blocks: [{ id: 'k', type: 'kpi-grid', props: { items: [{ label: 'Bedrooms', value: '{{property.bedrooms}}' }] } }] }, firstHomeBuyer.pages[1]],
    };
    const cov = measureBindingCoverage(snapshot, investmentData);
    expect(cov.carriesContent).toBe(true);
    expect(cov.needsComposition).toBe(false);
    expect(composeTemplateWithDonor(snapshot, master, investmentData)).toBeNull();
  });

  it('keeps a static page of the chosen template in front of the body, and drops only the blank ones', () => {
    const withStatic = {
      ...firstHomeBuyer,
      pages: [firstHomeBuyer.pages[0], { id: 'static', name: 'How to read this', blocks: [{ id: 's', type: 'text-block', props: { heading: 'How to read this', body: 'Static prose.' } }] }, ...firstHomeBuyer.pages.slice(1)],
    };
    const result = composeTemplateWithDonor(withStatic, master, investmentData)!;
    expect(result.kept.map((p) => p.name)).toEqual(['Cover', 'How to read this', 'Important information']);
    expect(result.dropped.map((p) => p.name)).toEqual(['What you can do', 'The real cost']);
  });

  it('never leaves two pages with one id', () => {
    const clash = { ...master, pages: master.pages.map((p) => (p.id === 'm-contents' ? { ...p, id: 'seed-page-2' } : p)) };
    const result = composeTemplateWithDonor(firstHomeBuyer, clash, investmentData)!;
    const ids = (result.schema.pages as Array<{ id: string }>).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('seed-page-2-body');
  });
});

describe('mergeTokens', () => {
  it('merges objects one level deep and lets the chosen scalar win', () => {
    expect(mergeTokens({ colors: { a: '1', b: '2' }, fontFaces: [{ family: 'X' }] }, { colors: { b: '3' }, fontFaces: [] }))
      .toEqual({ colors: { a: '1', b: '3' }, fontFaces: [] });
  });
});
