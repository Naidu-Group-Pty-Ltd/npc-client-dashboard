/**
 * Does the picture classifier get THIS repository's own brochures right?
 *
 * The classifier is worth putting in front of a client's card only if it is
 * right about the documents that made it necessary, and no test with a stub
 * binding can show that: a stub answers whatever the test wrote. So this runs
 * the real thing — the repository's own PDF reader picks the page and pulls
 * the rasters out of it, and the deployed worker's own model says what each
 * one shows.
 *
 *   deno run -A scripts/builder-stock/classify-brochure-page.ts \
 *     --pdf ./brochure.pdf \
 *     --label "Lot 313, Thornhill Gardens, Thornhill Park" \
 *     --worker https://builder-stock-image-worker.<subdomain>.workers.dev \
 *     --token "$BUILDER_STOCK_IMAGE_WORKER_TOKEN"
 *
 * Add `--page N` to classify a page the document did not designate — useful
 * for looking at a brochure whose cover rule already answers, and never a way
 * of choosing a page for production, which reads the document.
 *
 * WHAT COUNTS AS PASSING, and it is deliberately strict: EXACTLY ONE raster on
 * the page comes back `shows_house_exterior` with `confident: true`. Zero is a
 * classifier that cannot help; two is a classifier that would have made the
 * choice by coin toss. Both are reasons to leave it out of the selection path,
 * not reasons to soften the rule that consults it.
 *
 * It writes nothing, reaches no database and changes no property. The pictures
 * go to the worker and the verdicts come back to this terminal.
 */
import {
  countPdfPages, IDENTITY, objectStreamSlices, parseImagePlacements, parseObjectStream,
  qualifyingPhotographsFrom, readPdfPage, resolveDrawnForms, resolveDrawnImages,
  widgetBaseMatrix, type DrawnImage, type Matrix, type PdfScope,
} from '../../supabase/functions/_shared/builderStock/pdfPageImages.pure.ts';
import { findPropertyCoverPages } from '../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure.ts';
import { readPdfPageTextResult } from '../../supabase/functions/_shared/builderStock/pdfText.ts';
import { inflate } from '../../supabase/functions/_shared/builderStock/rasterPng.ts';

/** The worker's own ceiling. A page with more rasters is sent in batches. */
const BATCH = 6;

function argument(name: string): string | null {
  const at = Deno.args.indexOf(`--${name}`);
  return at >= 0 ? (Deno.args[at + 1] ?? null) : null;
}

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  Deno.exit(2);
}

/** The same descent the settler performs, including widget appearances. */
async function drawnOnPage(
  bytes: Uint8Array,
  scope: PdfScope,
  content: string,
  base: Matrix,
  depth: number,
): Promise<DrawnImage[]> {
  const placements = parseImagePlacements(content, base);
  const out: DrawnImage[] = resolveDrawnImages(scope, placements);
  if (depth >= 4) return out;
  for (const { form, base: formBase } of resolveDrawnForms(scope, placements)) {
    try {
      const raw = bytes.slice(form.start, form.end);
      const text = new TextDecoder('latin1').decode(form.flate ? await inflate(raw) : raw);
      out.push(...await drawnOnPage(bytes, form, text, formBase, depth + 1));
    } catch { /* a form we cannot inflate contributes nothing */ }
  }
  return out;
}

const pdfPath = argument('pdf') ?? die('--pdf <file> is required');
const label = argument('label') ?? '';
const worker = (argument('worker') ?? '').replace(/\/+$/, '');
const token = argument('token') ?? Deno.env.get('BUILDER_STOCK_IMAGE_WORKER_TOKEN') ?? '';
if (!worker) die('--worker <url> is required — the deployed worker, not a local file');
if (!token) die('--token, or BUILDER_STOCK_IMAGE_WORKER_TOKEN in the environment, is required');

const bytes = await Deno.readFile(pdfPath);

// The objects a PDF 1.5+ writer hides in compressed streams — without these
// the page tree itself is unreadable and "page 2" means nothing.
const recovered = new Map<number, string>();
for (const slice of objectStreamSlices(bytes)) {
  try {
    const raw = bytes.slice(slice.start, slice.end);
    const text = new TextDecoder('latin1').decode(slice.flate ? await inflate(raw) : raw);
    for (const [number, header] of parseObjectStream(text, slice)) recovered.set(number, header);
  } catch { /* an unreadable object stream contributes nothing */ }
}

let page = Number(argument('page') ?? 0);
if (!page) {
  if (!label) die('--label is required unless --page names the page to look at');
  const text = await readPdfPageTextResult(bytes);
  if (!text.ok) die(`the document's text could not be read: ${text.reason}`);
  const covers = findPropertyCoverPages(text.pages, label);
  if (!covers.length) {
    die(`no page states "${label}" together with its package information — `
      + 'there is nothing here for a classifier to choose between');
  }
  // Most package facts wins, exactly as `resolvePropertyCover` decides it.
  const most = Math.max(...covers.map((cover) => cover.packageFacts.length));
  page = covers.filter((cover) => cover.packageFacts.length === most)[0].page;
  console.log(`\n  the document designates visible page ${page} as this property's cover`);
}
if (page < 1 || page > countPdfPages(bytes, recovered)) die(`page ${page} is not in this document`);

const read = readPdfPage(bytes, page - 1, recovered);
if (!read) die(`page ${page} could not be read`);

let content = '';
for (const slice of read.contents) {
  try {
    const raw = bytes.slice(slice.start, slice.end);
    content += new TextDecoder('latin1').decode(slice.flate ? await inflate(raw) : raw);
  } catch { /* an unreadable content stream contributes nothing */ }
}
const drawn = await drawnOnPage(bytes, read, content, IDENTITY, 0);
for (const widget of read.widgets) {
  try {
    const raw = bytes.slice(widget.form.start, widget.form.end);
    const text = new TextDecoder('latin1').decode(widget.form.flate ? await inflate(raw) : raw);
    drawn.push(...await drawnOnPage(bytes, widget.form, text, widgetBaseMatrix(widget), 1));
  } catch { /* an appearance we cannot inflate contributes nothing */ }
}

/*
 * Every raster the page draws, WITHOUT the pixel and page-share floors. This
 * is the set the classifier would be asked about, and the floors are exactly
 * what cannot be applied to it: on the brochure that made this necessary the
 * facade render is 480x339 and fails the pixel floor, while the wordmark is
 * 3423x1588 and passes it.
 */
const candidates = qualifyingPhotographsFrom(drawn, read.width, read.height)
  .concat(drawn
    .filter(({ image }) => image.width * image.height >= 100_000)
    .map(({ image, placement }) => ({ image, placement, pageAreaShare: 0, placements: 1 })))
  .filter((candidate, index, all) =>
    all.findIndex((other) => other.image.objectNumber === candidate.image.objectNumber) === index);

if (!candidates.length) die(`page ${page} draws no raster this could ask about`);

const pictures = candidates.map(({ image }) => ({
  key: `${image.objectNumber}`,
  what: `${image.width}x${image.height} ${image.filters.join('+') || 'raw'}`,
  bytes: bytes.slice(image.start, image.end),
}));

console.log(`  ${pictures.length} raster(s) on that page; asking the worker what each shows\n`);

const verdicts = new Map<string, { subject: string | null; confident: boolean; why: string | null }>();
for (let at = 0; at < pictures.length; at += BATCH) {
  const batch = pictures.slice(at, at + BATCH);
  const form = new FormData();
  for (const picture of batch) {
    form.append(`image-${picture.key}`, new Blob([picture.bytes]), `${picture.key}.bin`);
  }
  const response = await fetch(`${worker}/v1/classify`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const body = await response.json().catch(() => null) as {
    error?: string;
    verdicts?: Array<{ key: string; subject: string | null; confident: boolean; unavailable: string | null }>;
  } | null;
  if (!response.ok || !body?.verdicts) {
    die(`the worker answered ${response.status}: ${body?.error ?? 'no readable body'}`);
  }
  for (const verdict of body.verdicts) {
    verdicts.set(verdict.key, {
      subject: verdict.subject, confident: verdict.confident, why: verdict.unavailable,
    });
  }
}

let leading = 0;
for (const picture of pictures) {
  const verdict = verdicts.get(picture.key);
  const said = verdict?.subject
    ? `${verdict.subject}${verdict.confident ? '' : ' (not confident)'}`
    : `no verdict — ${verdict?.why ?? 'the worker returned nothing for this picture'}`;
  const leads = verdict?.subject === 'shows_house_exterior' && verdict.confident;
  if (leads) leading += 1;
  console.log(`  ${leads ? '->' : '  '} obj${picture.key.padEnd(6)} ${picture.what.padEnd(26)} ${said}`);
}

console.log('');
if (leading === 1) {
  console.log('  PASS — exactly one raster on this page is a house from the street.\n');
  Deno.exit(0);
}
console.log(leading === 0
  ? '  FAIL — nothing on this page reads as a house, so the classifier cannot '
    + 'help here.\n'
  : `  FAIL — ${leading} rasters read as a house, so choosing between them would `
    + 'be a coin toss.\n');
Deno.exit(1);
