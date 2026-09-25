/**
 * A service note in a reader's words, where the service wrote a diagnostic.
 *
 * `planning-data-service` answered a jurisdiction whose state development
 * instruments it does not read with "State development-instrument layers are
 * integrated for Queensland only so far." That is a statement about this
 * platform's build, and it reached a client's page verbatim — four times on
 * the 60 Lawley Street, Spalding Compass delivered on 25 Sep 2026: in the
 * planning chapter, the infrastructure chapter, the risk register and the
 * register table.
 *
 * The LIMITATION is real and the reader needs it — no state
 * development-instrument register was searched for Western Australia, so
 * nothing about that property follows from one. Only the PHRASING was ours.
 * The service now writes the reader's sentence itself, and answers stored
 * before that carry the old words for as long as they are cached, so both
 * surfaces that print a register note (`planningFacts`, which the planning
 * table reads, and `infrastructureEvidence`, which the register and the
 * model's rules read) pass it through here.
 *
 * Only a note this module recognises is rewritten; every other note is
 * returned exactly as the service wrote it.
 */

export const JURISDICTION_NAME: Readonly<Record<string, string>> = {
  NSW: 'New South Wales',
  VIC: 'Victoria',
  QLD: 'Queensland',
  WA: 'Western Australia',
  SA: 'South Australia',
  TAS: 'Tasmania',
  ACT: 'the Australian Capital Territory',
  NT: 'the Northern Territory',
};

const BUILD_NOTE = /integrated for Queensland only so far/i;

export function readerNote(note: string | null, jurisdiction: string | null): string | null {
  if (!note) return note;
  if (BUILD_NOTE.test(note)) {
    const where = (jurisdiction && JURISDICTION_NAME[jurisdiction]) || 'this jurisdiction';
    return `No state development-instrument register was searched for ${where}: the only such register `
      + 'this report reads is Queensland\'s.';
  }
  return note;
}
