/**
 * Builder stock — reading the package a stock row links to.
 *
 * A row of the live Notion list carries one link of its own: "Complete Package
 * Pack", a Google Drive folder. Forty-four of the forty-five rows without a
 * cover point at the SAME folder, so the link alone attributes nothing — it is
 * an estate's document library, not a property's photograph.
 *
 * What makes attribution deterministic is that the library NAMES its contents:
 *
 *     Tweed Heads/Tweed Heads Packages/Lot 43/Lot 43 - Stradbroke 180 - Property Package.pdf
 *
 * and the stock row is "Lot 43 — Tringa Street, Sandpiper Estate … [Stradbroke
 * 180]". The folder names the lot and the file names the lot AND the house
 * design, which together are exactly one stock row. That is the source stating
 * the relationship, not us inferring one from a resemblance.
 *
 * THE RULES THIS MODULE ENFORCES:
 *   • EXACTLY ONE, or nothing. One folder named for the lot, one file naming
 *     that lot and that design. Two candidates is not a near miss — it is the
 *     source declining to say, and the answer is no image.
 *   • NOTHING OUTSIDE THE LINKED FOLDER. Descent is bounded and downward only;
 *     no id is ever constructed, guessed or followed out of the tree the row
 *     itself pointed at.
 *
 * Pure: no imports, no IO, no clock.
 */

/** One entry of a public Drive folder listing. */
export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
}

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Drive's public surfaces, and nothing else may be fetched as a package. */
export function isGoogleDriveHost(host: string): boolean {
  const clean = String(host ?? '').toLowerCase().replace(/\.$/, '');
  return clean === 'drive.google.com' || clean === 'docs.google.com'
    || clean === 'drive.usercontent.google.com';
}

/** The folder a link points at, when it points at one. */
export function driveFolderId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!isGoogleDriveHost(url.hostname)) return null;
    const match = /\/(?:drive\/(?:u\/\d+\/)?folders|drive\/folders)\/([A-Za-z0-9_-]{10,})/
      .exec(url.pathname);
    if (match) return match[1];
    if (/\/(?:drive|open)\/?$/.test(url.pathname)) {
      const id = url.searchParams.get('id');
      return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** The single file a link points at, for a row that links a document directly. */
export function driveFileId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!isGoogleDriveHost(url.hostname)) return null;
    const match = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
    if (match) return match[1];
    if (url.pathname === '/uc' || url.pathname === '/open') {
      const id = url.searchParams.get('id');
      return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

export const driveFolderUrl = (id: string): string =>
  `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;

/**
 * The public download address for a file.
 *
 * `uc?export=download` is what a logged-out browser follows from a shared
 * link. Nothing authenticated is involved, and a file that is not actually
 * shared answers with a sign-in page — which the byte check downstream refuses
 * as "not an image", rather than storing somebody's login screen.
 */
export const driveDownloadUrl = (id: string): string =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;

/**
 * Decode the listing a public folder page carries.
 *
 * A shared Drive folder renders client-side, but the response embeds the
 * listing as `window['_DRIVE_ivd']` — a hex-escaped JSON array, which is what
 * the page's own script parses. This reads that JSON. NO SCRIPT IS EXECUTED
 * and nothing is fetched here; a folder that is not public carries no listing
 * and yields an empty array, which is the correct answer for it.
 */
export function parseDriveFolderListing(html: string): DriveEntry[] {
  const match = /window\['_DRIVE_ivd'\]\s*=\s*'((?:[^'\\]|\\.)*)'/.exec(String(html ?? ''));
  if (!match) return [];

  const decoded = match[1]
    .replace(/\\x([0-9a-fA-F]{2})/g, (_whole, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, '/');

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0] : [];

  const out: DriveEntry[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const id = typeof row[0] === 'string' ? row[0] : '';
    const name = typeof row[2] === 'string' ? row[2] : '';
    const mimeType = typeof row[3] === 'string' ? row[3] : '';
    if (!id || !name || !mimeType) continue;
    // `&` and friends survive the hex unescaping above.
    out.push({ id, name: name.replace(/\\u0026/g, '&'), mimeType });
  }
  return out;
}

/** Punctuation, case and spacing removed to one space, so "LOT 43" = "Lot 43". */
export function normaliseDriveName(value: string): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A design name with the TENURE wording taken out of it.
 *
 * The stock list writes how a house is HELD — "[Bishop 258 Dual Occ]" — inside
 * the same bracket it writes the design in. The builder never does: the file is
 * "Lot 51 - Bishop 258 - Property Package.pdf" and its own cover reads "Bishop
 * 258, Mira facade" over "Dual key home, 4 + 2". The design and its number are
 * the part BOTH sides state; the tenure is one side's vocabulary for the
 * other's, and the two spellings share not a single token.
 *
 * WHY IT IS SHARED RATHER THAN COPIED. This was applied when choosing WHICH
 * document in the lot folder is a property's, and not when asking whether that
 * document's cover names the property — so nineteen Sandpiper rows selected
 * exactly the right package, opened it, reached the right page, and refused it
 * because the page does not contain the letters "occ". Choosing a document and
 * recognising its cover are the same question about the same label, and
 * answering them with two different readings of it is what left a blank card in
 * front of the builder's own photograph.
 *
 * It removes wording and never adds any, so nothing it touches can begin to
 * match a design it did not already match.
 */
export function withoutTenureWording(design: string): string {
  return String(design ?? '').replace(/\b(dual\s*occ(?:upancy)?|dual\s*key)\b/gi, ' ');
}

/**
 * The lot and the house design a stock row names.
 *
 * Both come from the row's own label — "Lot 43 - Tringa Street, Sandpiper
 * Estate, Tweed Heads South NSW 2486 [Stradbroke 180]". The bracketed design
 * is what distinguishes seven rows that share one lot, so a row without one is
 * identified by its lot alone and will only match a folder holding a single
 * document.
 *
 * "Dual Occ" / "Dual Key" are dropped by `withoutTenureWording`, for the reason
 * recorded there.
 */
export function lotAndDesignFrom(label: string): { lot: string | null; design: string | null } {
  const text = String(label ?? '');
  const lot = /(?:^|[^a-z0-9])lot\s*([0-9]{1,6}[a-z]?)\b/i.exec(text)?.[1] ?? null;

  const bracketed = /\[([^\]]{1,60})\]/.exec(text)?.[1] ?? '';
  const design = /([a-z][a-z' -]{2,24}\s+\d{2,4})/i.exec(withoutTenureWording(bracketed))?.[1]
    ?? null;

  return {
    lot: lot ? lot.toLowerCase() : null,
    design: design ? normaliseDriveName(design) : null,
  };
}

/**
 * The one folder in this listing that is named for this lot.
 *
 * Equality on the normalised name, never containment: "Lot 5" must not match
 * "Lot 51". Two folders with the same name — the live library has three called
 * "Lot 53" — is an ambiguity the source has to resolve, not us.
 */
export function selectLotFolder(entries: DriveEntry[], lot: string): string | null {
  const wanted = `lot ${normaliseDriveName(lot)}`;
  const hits = entries.filter((entry) =>
    entry.mimeType === DRIVE_FOLDER_MIME && normaliseDriveName(entry.name) === wanted);
  return hits.length === 1 ? hits[0].id : null;
}

/**
 * The one document in this listing that names this lot AND this design.
 *
 * Both halves are required when the row states both, because a lot folder
 * holds one package per design and picking any of them for a row that named
 * one would be a guess. A row with no design matches only when the folder
 * holds exactly one document naming the lot.
 */
/**
 * What KIND of document a builder's own filename says this is.
 *
 * A package library holds several documents about one property, and only one of
 * them is the property package. Lot 914 Covella's folder is exactly that:
 *
 *   LOT 914 • COVELLA • GREENBANK QLD.pdf              the package
 *   OTP_Land_Contract_P1_-_Rana_-_Lot_914_Covella.pdf  a contract
 *   Rental Appraisal_ Lot 914, Covella Estate ….pdf    an appraisal
 *
 * All three name Lot 914, so a rule that asks only "which files name this lot"
 * finds three and correctly refuses — and a real facade the builder supplied
 * stays off the card for want of a question nobody asked.
 *
 * THIS IS DOCUMENT KIND, NOT IMAGE CONTENT. It reads the name the builder gave
 * the FILE to decide what the file is for; it makes no judgement about any
 * picture, and nothing here can promote or demote an image. That distinction is
 * why naming these words is legitimate where naming marketing words never is:
 * a contract is a contract because its author called it one.
 *
 * IT ONLY EVER EXCLUDES. A document is a package candidate unless its name
 * declares it something else — so a builder who names a package
 * "LOT 914 • COVELLA • GREENBANK QLD.pdf", with no word for what it is,
 * remains a candidate. Requiring the word "package" instead would have thrown
 * that exact file away.
 */
export type DriveDocumentKind = 'package_candidate' | 'contract' | 'appraisal' | 'reference';

/**
 * Words that declare a document to be something other than a property package.
 *
 * Each is a document TYPE a builder library holds beside its packages, and each
 * appears in the live folders. Deliberately narrow: anything not matched stays
 * a candidate, so the cost of an omission here is the behaviour this already
 * had, and the cost of a wrong entry is a package refused rather than a wrong
 * picture shown.
 */
const NOT_A_PACKAGE: ReadonlyArray<readonly [DriveDocumentKind, RegExp]> = [
  ['contract', /\b(contract|otp|offer to purchase|sale of land|conveyanc)/],
  ['appraisal', /\b(appraisal|valuation|rental assessment)/],
  ['reference', /\b(inclusion|specification|price list|pricelist|stocklist|stock list|acoustic|soil|survey|covenant|disclosure|brochure pack|investment report)/],
];

/** The kind a document's own name declares. Candidates are the default. */
export function driveDocumentKind(name: string): DriveDocumentKind {
  const clean = normaliseDriveName(name);
  for (const [kind, pattern] of NOT_A_PACKAGE) {
    if (pattern.test(clean)) return kind;
  }
  return 'package_candidate';
}

export function selectPackageDocument(
  entries: DriveEntry[],
  key: { lot: string; design: string | null },
): DriveEntry | null {
  const lotToken = `lot ${normaliseDriveName(key.lot)}`;
  const documents = entries.filter((entry) =>
    entry.mimeType !== DRIVE_FOLDER_MIME && entry.mimeType === 'application/pdf');

  const named = documents.filter((entry) => {
    const name = ` ${normaliseDriveName(entry.name)} `;
    if (!name.includes(` ${lotToken} `)) return false;
    return key.design ? name.includes(` ${key.design} `) : true;
  });

  /*
   * NARROWED BY KIND, AND ONLY WHERE IT HELPS.
   *
   * The kind filter runs on the documents that already name this property, and
   * its answer is taken only when it leaves EXACTLY ONE. Leaving two is the
   * library still declining to say which is the package; leaving none means
   * every candidate declared itself something else, and inventing a package out
   * of a contract is precisely what this must not do. Both fall through to the
   * unfiltered count, which is the behaviour that shipped — so this can turn a
   * refusal into a selection and can never turn one selection into another.
   */
  const packages = named.filter((entry) => driveDocumentKind(entry.name) === 'package_candidate');
  if (named.length !== 1 && packages.length === 1) return packages[0];

  return named.length === 1 ? named[0] : null;
}
