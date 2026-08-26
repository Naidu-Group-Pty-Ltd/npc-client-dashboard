/**
 * The submission record as a PDF — the download the reviewer keeps.
 *
 * ── A presentation, never a second source ─────────────────────────────
 * This renders the SAME `SubmissionRecord` structure the reading view, the
 * self-contained HTML and the stored copy come from
 * (`submissionRecord.pure.ts`). Nothing here reads the review payload —
 * every string on the page was already decided by `buildSubmissionRecord`,
 * so the PDF cannot say anything the other presentations do not.
 *
 * ── Why jsPDF, drawn directly ─────────────────────────────────────────
 * Direct text drawing is this repo's established client-download path
 * (`OverviewSnapshotPDF.ts` and kin), it produces selectable, searchable
 * text, and it runs entirely in the browser from the data on screen — no
 * edge round-trip, no render container, nothing fetched from anywhere. The
 * WeasyPrint report programme is deliberately untouched: the record is an
 * internal compliance artefact, not a branded client report, so none of the
 * template machinery, tenant branding or ledger rows apply. Never
 * rasterise this through html2canvas — a compliance record must stay text.
 *
 * ── Print rules that DO apply (REPORT_RULES.md) ───────────────────────
 * Small type keeps a ≥7:1 contrast floor: labels and running feet are
 * achromatic greys chosen for it, ink is near-black on white. No logo asset
 * appears (the record is internal, and most repo "logos" are signature
 * banners), no engine name is printed, dates arrive already formatted by
 * the shared `formatUtc`.
 */
import type { RecordBlock, RecordTable, SubmissionRecord } from "@/lib/aml/submissionRecord";

/** `…-record.html` → `…-record.pdf` — one filename rule, one extension swap. */
export function submissionRecordPdfFilename(record: Pick<SubmissionRecord, "filename">): string {
  return record.filename.replace(/\.html$/, ".pdf");
}

/* A4 in mm. */
const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 18;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOT_Y = PAGE_H - 11;
/** Content must stop above the running foot. */
const CONTENT_BOTTOM = PAGE_H - MARGIN - 4;

const PT_TO_MM = 0.3528;
const lineHeight = (pt: number) => pt * PT_TO_MM * 1.45;

/* Achromatic palette. #555 on white is ≈7.5:1 — over the 7:1 floor the
 * print rules set for sub-10pt type. */
const INK: [number, number, number] = [17, 17, 17];
const LABEL: [number, number, number] = [85, 85, 85];
const RULE_DARK = 120;
const RULE_LIGHT = 210;

/* 44mm holds the longest label the record produces ("Risk assessment
 * standing", "Service gate (read-only)") without wrapping; 62mm left a dead
 * trench between question and answer across the whole page. */
const LABEL_COL_W = 44;
const GRID_GAP = 4;
/** One trailing pad after every block, so a section heading always gets the
 *  same space-before whatever precedes it. */
const BLOCK_PAD = 2;

interface Cursor { y: number }

type Doc = import("jspdf").jsPDF;

function newPageIfNeeded(doc: Doc, cursor: Cursor, needed: number): boolean {
  if (cursor.y + needed <= CONTENT_BOTTOM) return false;
  doc.addPage();
  cursor.y = MARGIN;
  return true;
}

function drawLabelled(doc: Doc, cursor: Cursor, label: string, value: string) {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  const labelLines = doc.splitTextToSize(label.toUpperCase(), LABEL_COL_W) as string[];
  doc.setFontSize(9.5);
  const valueLines = doc.splitTextToSize(value, CONTENT_W - LABEL_COL_W - GRID_GAP) as string[];
  const rowH = Math.max(labelLines.length * lineHeight(7.5), valueLines.length * lineHeight(9.5)) + 1.1;
  newPageIfNeeded(doc, cursor, rowH);
  // Label and value share ONE baseline — the value's. Offsetting each by its
  // own line height staggered every row by 0.8mm, which read as unset type
  // beside the tables (whose header and cells align exactly).
  const baseline = cursor.y + lineHeight(9.5) * 0.8;
  doc.setFontSize(7.5);
  doc.setTextColor(...LABEL);
  doc.text(labelLines, MARGIN, baseline);
  doc.setFontSize(9.5);
  doc.setTextColor(...INK);
  doc.text(valueLines, MARGIN + LABEL_COL_W + GRID_GAP, baseline);
  cursor.y += rowH;
}

/**
 * Column widths from MEASURED text, not character counts — a proportional
 * face renders 22 chars of date narrower than 17 chars of hex, so counting
 * characters starved exactly the columns that needed width. Each column's
 * natural width is the widest of its rendered header and rendered cells
 * (capped, so one opaque filename cannot starve the rest); the set is then
 * scaled to fill the content width so every table ends on the right rule.
 * A cell wider than its column wraps — it is never truncated.
 */
function tableColumnWidths(doc: Doc, table: RecordTable): number[] {
  const MIN_W = 16;
  const CAP_W = 78;
  const PAD = 4;
  const natural = table.columns.map((c, i) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    let w = doc.getTextWidth(c.toUpperCase());
    for (const row of table.rows) {
      const cell = row[i] || "—";
      // A hex literal draws in Courier at 8.5pt (see drawTable) — measure it
      // in the face it will wear, or the column is sized for the wrong text.
      doc.setFont(isHexLiteral(cell) ? "courier" : "helvetica", "normal");
      doc.setFontSize(isHexLiteral(cell) ? 8.5 : 9.5);
      w = Math.max(w, doc.getTextWidth(cell));
    }
    return Math.min(Math.max(w + PAD, MIN_W), CAP_W);
  });
  doc.setFont("helvetica", "normal");
  const total = natural.reduce((a, b) => a + b, 0);
  const scaled = natural.map((w) => (w / total) * CONTENT_W);
  for (let i = 0; i < scaled.length; i++) {
    if (scaled[i] < MIN_W) {
      const deficit = MIN_W - scaled[i];
      scaled[i] = MIN_W;
      scaled[scaled.indexOf(Math.max(...scaled))] -= deficit;
    }
  }
  /*
   * Snap every interior column edge to a 5mm grid. Stacked tables carry
   * their own measured grids by design — but measurement makes two terminal
   * columns land 1.3mm apart, and NEAR-alignment reads as a wobble where
   * either exact alignment or a visible difference reads as intent.
   */
  const edges: number[] = [];
  let cum = 0;
  for (let i = 0; i < scaled.length - 1; i++) {
    cum += scaled[i];
    const prev = edges[i - 1] ?? 0;
    const remaining = (scaled.length - 1 - i) * MIN_W;
    edges.push(Math.min(
      // The min-width lift rounds UP to the next grid step — a floored
      // column that lands off-grid can near-align with a neighbouring
      // table, which is the wobble the snap exists to prevent.
      Math.max(Math.round(cum / 5) * 5, Math.ceil((prev + MIN_W) / 5) * 5),
      CONTENT_W - remaining,
    ));
  }
  edges.push(CONTENT_W);
  return edges.map((e, i) => e - (edges[i - 1] ?? 0));
}

/** A long hex token is a literal — a hash, a key. It wears a monospaced
 *  face: more digits fit before wrapping, and the face itself says "read me
 *  back character by character". */
const isHexLiteral = (s: string) => /^[0-9a-f]{24,}$/i.test(s.trim());

function drawTableHeader(doc: Doc, cursor: Cursor, table: RecordTable, widths: number[]) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(...LABEL);
  let x = MARGIN;
  const h = lineHeight(7.5) + 1.2;
  table.columns.forEach((c, i) => {
    doc.text(c.toUpperCase(), x, cursor.y + lineHeight(7.5) * 0.8, { maxWidth: widths[i] - 2 });
    x += widths[i];
  });
  cursor.y += h;
  doc.setDrawColor(RULE_DARK);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, cursor.y, MARGIN + CONTENT_W, cursor.y);
  cursor.y += 1.2;
  doc.setFont("helvetica", "normal");
}

function drawTable(doc: Doc, cursor: Cursor, table: RecordTable) {
  const widths = tableColumnWidths(doc, table);
  newPageIfNeeded(doc, cursor, lineHeight(7.5) + lineHeight(9.5) * 2 + 6);
  drawTableHeader(doc, cursor, table, widths);
  for (const row of table.rows) {
    const cells = row.map((cell, i) => {
      const text = cell || "—";
      const mono = isHexLiteral(text);
      doc.setFont(mono ? "courier" : "helvetica", "normal");
      doc.setFontSize(mono ? 8.5 : 9.5);
      return {
        mono,
        size: mono ? 8.5 : 9.5,
        lines: doc.splitTextToSize(text, widths[i] - 3) as string[],
      };
    });
    const rowH = Math.max(...cells.map((c) => c.lines.length * lineHeight(c.size))) + 2.2;
    // A row never splits; the header travels to the new page with it.
    if (newPageIfNeeded(doc, cursor, rowH)) {
      drawTableHeader(doc, cursor, table, widths);
    }
    doc.setTextColor(...INK);
    // One baseline for the whole row, whatever face each cell wears.
    const baseline = cursor.y + lineHeight(9.5) * 0.8;
    let x = MARGIN;
    cells.forEach((c, i) => {
      doc.setFont(c.mono ? "courier" : "helvetica", "normal");
      doc.setFontSize(c.size);
      doc.text(c.lines, x, baseline);
      x += widths[i];
    });
    doc.setFont("helvetica", "normal");
    cursor.y += rowH;
    doc.setDrawColor(RULE_LIGHT);
    doc.setLineWidth(0.2);
    doc.line(MARGIN, cursor.y - 0.8, MARGIN + CONTENT_W, cursor.y - 0.8);
  }
  cursor.y += BLOCK_PAD;
}

function drawBlock(doc: Doc, cursor: Cursor, block: RecordBlock) {
  if (block.heading) {
    // Reserve the heading AND one row beneath it, so a group title can never
    // print as the last line of a page with its first field overleaf.
    newPageIfNeeded(doc, cursor, lineHeight(9.5) + 15.5);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...INK);
    cursor.y += 2;
    doc.text(block.heading, MARGIN, cursor.y + lineHeight(9.5) * 0.8);
    cursor.y += lineHeight(9.5) + 1.5;
    doc.setFont("helvetica", "normal");
  }
  if (block.paragraph) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    // Space-before, so a sentence following a fields block reads as prose
    // and not as a value that slid out of the grid.
    cursor.y += 1.5;
    const lines = doc.splitTextToSize(block.paragraph, CONTENT_W) as string[];
    const h = lines.length * lineHeight(9.5) + BLOCK_PAD;
    newPageIfNeeded(doc, cursor, h);
    doc.setTextColor(...LABEL);
    doc.text(lines, MARGIN, cursor.y + lineHeight(9.5) * 0.8);
    cursor.y += h;
  }
  if (block.fields) {
    for (const f of block.fields) drawLabelled(doc, cursor, f.label, f.value);
    cursor.y += BLOCK_PAD;
  }
  if (block.table) drawTable(doc, cursor, block.table);
}

/**
 * Render the record to a PDF blob. jsPDF is imported lazily so the case
 * workspace pays nothing until somebody actually downloads.
 */
export async function generateSubmissionRecordPdf(record: SubmissionRecord): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  // Multi-line text draws at jsPDF's default 1.15 leading unless told
  // otherwise, while every height RESERVED here uses 1.45 — the mismatch
  // floats row rules away from wrapped text. One factor, set once.
  doc.setLineHeightFactor(1.45);
  const cursor: Cursor = { y: MARGIN };

  /* Document header — mirrors the HTML's: title, identity line, heavy rule.
   * The meta line stays UNDER body size: at 10.5pt it crowded the section
   * titles and the type scale lost its middle. */
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...INK);
  doc.text("Client submission record", MARGIN, cursor.y + lineHeight(16) * 0.8);
  cursor.y += lineHeight(16) + 1;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(...LABEL);
  doc.text(record.headerFields.map((f) => f.value).join("  ·  "), MARGIN, cursor.y + lineHeight(9.5) * 0.8);
  cursor.y += lineHeight(9.5) + 3;
  doc.setDrawColor(...INK);
  doc.setLineWidth(0.6);
  doc.line(MARGIN, cursor.y, MARGIN + CONTENT_W, cursor.y);
  cursor.y += 6;

  for (const section of record.sections) {
    // Never strand a section title at the page foot.
    newPageIfNeeded(doc, cursor, lineHeight(11.5) + 14);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11.5);
    doc.setTextColor(...INK);
    doc.text(section.title, MARGIN, cursor.y + lineHeight(11.5) * 0.8);
    cursor.y += lineHeight(11.5) + 1.2;
    doc.setDrawColor(RULE_DARK);
    doc.setLineWidth(0.25);
    doc.line(MARGIN, cursor.y, MARGIN + CONTENT_W, cursor.y);
    cursor.y += 3;
    for (const block of section.blocks) drawBlock(doc, cursor, block);
    cursor.y += 3.5;
  }

  /* The closing notice — the same words the HTML footer carries. The
   * reference and generation timestamp are NOT repeated here: the running
   * foot below already carries both on every page, and printing them twice
   * on one sheet reads as a mistake. Only what the foot lacks — who
   * generated it — precedes the notice. */
  const notice =
    "This record is a point-in-time export of the client submission review. It is internal to the "
    + "reporting entity: it includes screening states and risk readings and must not be provided to the client.";
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const noticeLines = doc.splitTextToSize(notice, CONTENT_W) as string[];
  // Pinned just above the running foot of the last page — a colophon sitting
  // wherever the content happened to stop reads as a truncated document.
  const colophonH = 3
    + (record.generatedBy ? lineHeight(8.5) + 1 : 0)
    + noticeLines.length * lineHeight(8.5);
  // 10mm above the foot, not 6: at 6 the foot read as a third line of the
  // colophon — same grey, same alignment, one point of size apart.
  if (cursor.y + 2 > FOOT_Y - 10 - colophonH) {
    doc.addPage();
  }
  cursor.y = FOOT_Y - 10 - colophonH;
  doc.setDrawColor(RULE_DARK);
  doc.setLineWidth(0.25);
  doc.line(MARGIN, cursor.y, MARGIN + CONTENT_W, cursor.y);
  cursor.y += 3;
  doc.setTextColor(...LABEL);
  if (record.generatedBy) {
    doc.text(`Generated by ${record.generatedBy}.`, MARGIN, cursor.y + lineHeight(8.5) * 0.8);
    cursor.y += lineHeight(8.5) + 1;
  }
  doc.text(noticeLines, MARGIN, cursor.y + lineHeight(8.5) * 0.8);

  /* Running foot on every page, once the page count is final. */
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...LABEL);
    doc.text(`${record.reference} · Submission v${record.version} · ${record.generatedAt}`, MARGIN, FOOT_Y);
    doc.text(`Page ${i} of ${pages}`, PAGE_W - MARGIN, FOOT_Y, { align: "right" });
  }

  return doc.output("blob");
}
