/**
 * Builder stock — recovering the render out of a row's OWN package document.
 *
 * The last place a builder-supplied photograph can be, once a row has no cover
 * and no file property: the "Complete Package Pack" link the row itself
 * carries. On the live list that is a Google Drive folder shared by 44 rows —
 * so the link attributes nothing, and everything here is about what the
 * library NAMES:
 *
 *   the row      Lot 43 — Tringa Street, Sandpiper Estate … [Stradbroke 180]
 *   the folder   …/Tweed Heads Packages/Lot 43/
 *   the document Lot 43 - Stradbroke 180 - Property Package.pdf
 *   the image    page 1
 *
 * Each step must resolve to EXACTLY ONE candidate or the whole attempt is
 * abandoned. Nothing is ranked, nothing is scored, and there is no "closest
 * match" — an ambiguity is the source declining to say which property a
 * picture belongs to, and the honest answer to that is the existing fallback.
 *
 * SECURITY. Every retrieval goes through `fetchStockSource`: the existing SSRF
 * guard on the original URL and on every redirect hop, http(s) only, 25 MB
 * ceiling, per-hop and total timeouts, and no cookie, Authorization header,
 * Supabase key, builder session or Google credential of any kind — a folder
 * that is not shared publicly simply answers with a page that carries no
 * listing. Descent is bounded and downward only: no id is constructed or
 * followed outside the tree the row pointed at.
 */
import {
  driveDownloadUrl, driveFileId, driveFolderId, driveFolderUrl, isGoogleDriveHost,
  lotAndDesignFrom, parseDriveFolderListing, selectLotFolder, selectPackageDocument,
  DRIVE_FOLDER_MIME, type DriveEntry,
} from './drivePackage.pure.ts';
import {
  selectPdfPropertyPrimary, type PdfPhotoProvenance,
} from './pdfSourcePhoto.ts';
import { readPdfPageTextResult } from './pdfText.ts';
import type { SourceImageRoleAssignment } from './sourceImageRole.pure.ts';

/** Folder listings one repair run may read. Shared and cached across rows. */
const MAX_LISTINGS_PER_RUN = 40;
/** How far below the linked folder a lot folder may be looked for. */
const MAX_DEPTH = 3;

export interface PackageFetcher {
  (url: string): Promise<{ bytes: Uint8Array; finalUrl: string }>;
}

/** The production fetcher, imported lazily so this module stays testable. */
const guardedFetch: PackageFetcher = async (url: string) => {
  const { fetchStockSource } = await import('./fetchSource.ts');
  const fetched = await fetchStockSource(url);
  return { bytes: fetched.bytes, finalUrl: fetched.finalUrl };
};

/** Reads a folder at most once per run, whoever asks for it. */
export class DriveListingCache {
  private readonly entries = new Map<string, DriveEntry[]>();
  private reads = 0;

  constructor(private readonly fetchPackage: PackageFetcher) {}

  get listings(): number { return this.reads; }

  async list(folderId: string): Promise<DriveEntry[]> {
    const cached = this.entries.get(folderId);
    if (cached) return cached;
    if (this.reads >= MAX_LISTINGS_PER_RUN) return [];

    this.reads += 1;
    try {
      const { bytes } = await this.fetchPackage(driveFolderUrl(folderId));
      const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const listing = parseDriveFolderListing(html);
      this.entries.set(folderId, listing);
      return listing;
    } catch {
      // A folder that will not load is a folder we have nothing to say about.
      this.entries.set(folderId, []);
      return [];
    }
  }
}

export interface RecoveredPackageImage {
  bytes: Uint8Array;
  contentType: string;
  /** Names the document and the page, so the row records where it came from. */
  reference: string;
  /** The Drive file the image was taken out of. */
  documentName: string;
  documentUrl: string;
  /**
   * Everything needed to prove this picture came out of this document —
   * which page, which object, how big it was, what it hashes to, and whether
   * anything was done to it.
   */
  provenance: PdfPhotoProvenance;
  /** What the package presented this image as, and on what evidence. */
  role: SourceImageRoleAssignment;
}

export type PackageOutcome =
  | { status: 'recovered'; image: RecoveredPackageImage }
  /** The link was read and stated nothing that identifies this property. */
  | { status: 'not_identified'; detail: string }
  /** The link could not be read at all without credentials. */
  | { status: 'unreachable'; detail: string };

/**
 * Find, fetch and extract the one image a row's own package document leads with.
 *
 * `label` is the row's own name — it carries both the lot and the house
 * design, and both have to appear on the document before it is accepted.
 */
export async function recoverPackageImage(
  input: { packageUrl: string; label: string },
  deps: {
    fetchPackage?: PackageFetcher;
    cache?: DriveListingCache;
    /**
     * How the package's prose is read, page by page.
     *
     * Injected for the same reason the fetcher is: the production reader
     * dynamically imports pdf.js from a CDN, which an offline test runner
     * cannot reach, and a rule nothing can exercise is a rule that drifts.
     */
    readPageTexts?: (bytes: Uint8Array) => Promise<string[]>;
  } = {},
): Promise<PackageOutcome> {
  const fetchPackage = deps.fetchPackage ?? guardedFetch;
  const cache = deps.cache ?? new DriveListingCache(fetchPackage);
  /*
   * An INJECTED reader is authoritative — a test that hands over page texts has
   * read them by definition. The production reader is the one that can fail to
   * load at all, so only it carries the distinction below.
   */
  const readPageTexts = deps.readPageTexts
    ? async (bytes: Uint8Array) => ({ ok: true as const, pages: await deps.readPageTexts!(bytes) })
    : readPdfPageTextResult;

  let host: string;
  try {
    host = new URL(input.packageUrl).hostname;
  } catch {
    return { status: 'not_identified', detail: 'The package link is not a web address.' };
  }
  if (!isGoogleDriveHost(host)) {
    return { status: 'not_identified', detail: 'That package is not on a source we can read.' };
  }

  const { lot, design } = lotAndDesignFrom(input.label);

  // A link straight to one document: the row named the file itself.
  const directFileId = driveFileId(input.packageUrl);
  if (directFileId) {
    return await extractFromDocument(
      fetchPackage, readPageTexts, directFileId, 'the linked document', input.label,
      'direct_link');
  }

  const rootId = driveFolderId(input.packageUrl);
  if (!rootId) {
    return { status: 'not_identified', detail: 'That package link names neither a folder nor a file.' };
  }
  if (!lot) {
    return { status: 'not_identified', detail: 'This property does not name a lot to look for.' };
  }

  const root = await cache.list(rootId);
  if (!root.length) {
    return { status: 'unreachable', detail: 'That package folder is not readable without signing in.' };
  }

  const lotFolderId = await findLotFolder(cache, root, lot);
  const entries = lotFolderId ? await cache.list(lotFolderId) : root;
  /*
   * A LIBRARY THAT FILES BY SUBJECT RATHER THAN BY LOT.
   *
   * Sandpiper's library keeps one folder per lot, which is what `findLotFolder`
   * looks for. Four live rows link a library that does the opposite: the folder
   * IS the property, and inside it are "Package", "Rental Appraisal" and "Area
   * Profile - Investment Report" — one folder per KIND of document. There is no
   * lot folder to find, the root holds only an estate-wide inclusions list, and
   * the property's own package sits one level down.
   *
   * So when no lot folder was found, the whole bounded subtree the search has
   * already read is offered to the same selector. It is not a wider search:
   * `findLotFolder` walked exactly these entries to conclude there was no lot
   * folder, so this costs no further listing, reaches nothing outside the folder
   * the row itself linked, and asks the identical question — one document, this
   * lot, this design, and of a kind that can be a package. Two candidates is
   * still the source declining to say, and the answer is still no image.
   */
  const document = selectPackageDocument(entries, { lot, design })
    ?? (lotFolderId
      ? null
      : selectPackageDocument(await subtreeEntries(cache, root), { lot, design }));
  if (!document) {
    return {
      status: 'not_identified',
      detail: lotFolderId
        ? 'No single document in that lot folder names this property.'
        : 'That folder names no document for this exact property.',
    };
  }

  return await extractFromDocument(
    fetchPackage, readPageTexts, document.id, document.name, input.label,
    'folder_structure');
}

/**
 * Every entry inside THIS linked folder, to the same bounded depth the lot
 * search uses.
 *
 * DESCENT FROM THIS ROOT, NEVER A READ OF THE CACHE. The cache is shared by
 * every row in a run — that is what keeps forty-four rows pointing at one
 * library to a handful of requests — so taking "everything read so far" from it
 * would pull in folders belonging to OTHER properties. Two Cloverton rows are
 * exactly that: each links its own folder, each folder holds one document
 * naming its own lot, and reading the cache flat made the two look like two
 * candidates for one property and produced no image for either.
 *
 * So it walks down from this root and no further, exactly as `findLotFolder`
 * does. Every listing it asks for was asked for by that search first, so the
 * cache answers all of them and this costs no request.
 */
async function subtreeEntries(
  cache: DriveListingCache,
  root: DriveEntry[],
): Promise<DriveEntry[]> {
  const all = [...root];
  let level = root;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const children = level
      .filter((entry) => entry.mimeType === DRIVE_FOLDER_MIME)
      .map((entry) => entry.id);
    if (!children.length) break;
    const next: DriveEntry[] = [];
    for (const id of children) next.push(...await cache.list(id));
    all.push(...next);
    level = next;
  }
  return all;
}

/**
 * The one folder named for this lot, searched downward from the linked folder.
 *
 * Breadth-first and bounded: a library keeps its per-lot folders under a
 * "Packages" folder, and finding it is a descent inside the tree the row
 * linked — never a step outside it.
 */
async function findLotFolder(
  cache: DriveListingCache,
  root: DriveEntry[],
  lot: string,
): Promise<string | null> {
  let level = root;
  let levelIds: string[] = [];

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const hit = selectLotFolder(level, lot);
    if (hit) return hit;

    const children = level
      .filter((entry) => entry.mimeType === DRIVE_FOLDER_MIME)
      .map((entry) => entry.id);
    if (!children.length) return null;

    const next: DriveEntry[] = [];
    levelIds = children;
    for (const id of levelIds) {
      next.push(...await cache.list(id));
    }
    level = next;
  }
  return null;
}

/**
 * Take the property's photograph out of one document.
 *
 * The finding and the downloading are this module's; everything that happens
 * to the bytes afterwards is `pdfSourcePhoto.ts`, which a directly uploaded
 * PDF goes through as well. One implementation, so a brochure reached through
 * a link and a brochure uploaded through the portal cannot disagree about
 * which picture is the property.
 */
async function extractFromDocument(
  fetchPackage: PackageFetcher,
  readPageTexts: (bytes: Uint8Array) => Promise<
    { ok: true; pages: string[] } | { ok: false; reason: string }>,
  fileId: string,
  documentName: string,
  /** The property this package is supposed to be about. */
  label: string,
  /**
   * HOW THIS DOCUMENT CAME TO BE THIS PROPERTY'S.
   *
   * `folder_structure` means the builder's own library tied it to exactly one
   * stock row before anything was downloaded: one folder named for the lot, one
   * PDF in it naming that lot and that design, and `selectPackageDocument`
   * returning null for anything other than exactly one. That tie is what
   * licenses the structural cover below.
   *
   * `direct_link` means the row linked a file rather than a folder, so nothing
   * has been established about WHICH property the document is about except that
   * the row pointed at it — and on the live list one folder is shared by
   * forty-four rows, so pointing is not naming. Those documents must state
   * their property in text like everything else.
   */
  identifiedBy: 'folder_structure' | 'direct_link',
): Promise<PackageOutcome> {
  const url = driveDownloadUrl(fileId);
  let bytes: Uint8Array;
  try {
    ({ bytes } = await fetchPackage(url));
  } catch (error) {
    return {
      status: 'unreachable',
      detail: String((error as { safeMessage?: string })?.safeMessage ?? 'That document could not be retrieved.'),
    };
  }

  // A share that actually needs a login answers with a sign-in page.
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    return { status: 'unreachable', detail: 'That document is not publicly downloadable.' };
  }

  /**
   * The SAME rule a directly uploaded PDF goes through: the package's own cover
   * page — the one stating this property's identity with its package
   * information — and the one picture presented with them. A package reached
   * through a link and the same package uploaded through the portal must not be
   * able to disagree about which picture is the property.
   */
  /**
   * A DOCUMENT WE COULD NOT READ IS NOT A DOCUMENT THAT SAYS NOTHING.
   *
   * The cover page is found by matching the property's own label against each
   * page's prose, so with no prose no page can be recognised and the selector
   * returns nothing — indistinguishable, from here, from a brochure that
   * genuinely does not present this property. The reader loads pdf.js from a CDN
   * at call time and used to answer an empty array when that import did not
   * resolve, which is how 44 Sandpiper Estate properties came to be told their
   * packages named no image for them: not one of those documents had been read.
   *
   * So a reader that failed is `unreachable` — operational, retried, and never
   * recorded as a finding — and only a document that was actually read may
   * answer `not_identified`.
   */
  const textResult = await readPageTexts(bytes);
  if (!textResult.ok) {
    return {
      status: 'unreachable',
      detail: `That document’s text could not be read (${"reason" in textResult ? textResult.reason : "unknown"}).`,
    };
  }
  /*
   * And zero pages is the same fault wearing a different hat, whichever reader
   * produced it: a PDF always has pages, so an empty list is the read failing
   * rather than the document being silent. Judged here rather than inside one
   * reader so every reader is held to it — the production one, and the ones
   * tests inject to stand in for it.
   */
  if (!textResult.pages.length) {
    return {
      status: 'unreachable',
      detail: 'That document\'s text could not be read (no pages came back).',
    };
  }
  /*
   * AND PAGES THAT CAME BACK EMPTY ARE THE SAME FAULT AGAIN.
   *
   * A package whose every page yields no text at all is not a package that says
   * nothing about the property — it is a package this reader cannot read. The
   * live list has them: "LOT 914 • COVELLA • GREENBANK QLD.pdf" is three pages
   * of designed brochure exported as images, and its first page carries the
   * lot, the estate, the suburb, the price, the land and house sizes and the
   * facade render, all of it drawn rather than set. Text extraction returns
   * zero characters from every page.
   *
   * Recording that as "the document names no image for this property" banks a
   * finished negative produced by a reader that never read the document — and
   * `negativeProvenanceStillStands` would then suppress the source until a
   * version bump. So it is operational, and the property is asked again: the
   * answer changes for free the day this can read a drawn page.
   *
   * PARTIAL emptiness is deliberately NOT this. A document with text on some
   * pages was read; that it says nothing identifying on the others is a fact
   * about the document.
   */
  const textFree = textResult.pages.every((text) => !String(text ?? '').trim());
  if (textFree && identifiedBy !== 'folder_structure') {
    return {
      status: 'unreachable',
      detail: 'That document\'s pages carry no extractable text, so it could not be read.',
    };
  }
  const pageTexts = textResult.pages;
  const selection = await selectPdfPropertyPrimary(bytes, {
    label,
    pageTexts,
    // Supplied ONLY when the builder's folder already named this document for
    // this one property and the document itself can say nothing. See
    // `assignPdfMediaRoles`.
    structuralCoverPage: textFree ? 1 : null,
  });
  const photo = selection.primary;
  if (!photo) {
    /*
     * A document nothing could be read from has still established nothing, even
     * where its first page was structurally eligible and presented no single
     * photograph. Recording a negative for it would bank an answer this reader
     * never earned, so it stays operational and the property is asked again.
     */
    if (textFree) {
      return {
        status: 'unreachable',
        detail: 'That document\'s pages carry no extractable text and its first page '
          + 'presents no single photograph, so it could not be read.',
      };
    }
    return {
      status: 'not_identified',
      detail: 'That document does not present a page as this property\'s package cover, '
        + 'so it names no image for it.',
    };
  }

  const suffix = photo.provenance.method === 'page_crop'
    ? `crop(${photo.provenance.crop?.top}-${photo.provenance.crop?.bottom})`
    : photo.provenance.resourceName;
  return {
    status: 'recovered',
    image: {
      bytes: photo.bytes,
      contentType: photo.contentType,
      reference: `${documentName}#page${photo.provenance.page}:${suffix}`,
      documentName,
      documentUrl: url,
      provenance: photo.provenance,
      role: photo.role,
    },
  };
}
