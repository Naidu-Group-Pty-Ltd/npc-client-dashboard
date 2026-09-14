/**
 * Close the hole a dropped block leaves in its column.
 *
 * A master lays a page out as a flow — `flow()` in the Investment Compass
 * builder stacks each block at the previous one's bottom plus a gap — and the
 * renderer positions every block absolutely at the `y` that flow assigned.
 * When a block on that page is then dropped (its conditional is false, or it
 * has nothing to draw — see `blockDrawsContent`), the blocks after it stay
 * where they were and the page carries a hole the size of the block that is
 * not there. Measured on the long reference report (RS-3c, 14 Sep 2026): the
 * Risk page's register is conditional on a risk the record does not carry,
 * so the page drew its heading at 103pt, nothing until 349pt, and the
 * recommendation there — a hole a third of a page tall between two lines of
 * a client document.
 *
 * The rule: the blocks below a dropped block, in its column, move up by the
 * distance to the first of them, so that block lands where the dropped one
 * began and the gap before it becomes the gap before them. Nothing else moves.
 *
 * What keeps that safe without a declared height (the masters carry none on
 * a flowed block): a shift is made only when nothing drawn sits in the band
 * between the dropped block's top and the first follower — a tile beside a
 * dropped tile keeps its row, and the blocks under the row stay put — and
 * only for blocks contained in the dropped block's own column, so a block
 * beside the column is never crossed. Furniture (running heads, part markers,
 * the section opener, feet and page numbers) never moves and never counts.
 * In the editor nothing moves either: an author needs to see what they built.
 */
import type { Block } from './templateSchema';

interface Geometry { x: number; y: number; width: number }

/** A drawn block above a dropped one, this close to its top, is read as a row-mate. */
export const ROW_MATE_REACH_PT = 24;

function geometryOf(block: Block): Geometry | null {
  const p = block.props as { x?: unknown; y?: unknown; width?: unknown } | undefined;
  const x = Number(p?.x), y = Number(p?.y), width = Number(p?.width);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || width <= 0) return null;
  return { x, y, width };
}

export function closeDroppedBlocks(
  blocks: readonly Block[],
  isDropped: (block: Block) => boolean,
  isFurniture: (block: Block) => boolean,
): Block[] {
  const content = blocks.filter((b) => !isFurniture(b) && geometryOf(b) !== null);
  // Asked once per block: answering it renders the block.
  const droppedIds = new Set(content.filter(isDropped).map((b) => b.id));
  const dropped = content.filter((b) => droppedIds.has(b.id)).sort((a, b) => geometryOf(a)!.y - geometryOf(b)!.y);
  if (!dropped.length) return [...blocks];
  const drawn = content.filter((b) => !droppedIds.has(b.id));
  const shift = new Map<string, number>();
  const yOf = (b: Block) => geometryOf(b)!.y + (shift.get(b.id) ?? 0);

  for (const d of dropped) {
    const g = geometryOf(d)!;
    const top = yOf(d);
    const inColumn = (b: Block) => {
      const bg = geometryOf(b)!;
      return bg.x >= g.x - 1 && bg.x + bg.width <= g.x + g.width + 1;
    };
    const followers = drawn.filter((b) => yOf(b) > top + 0.5 && inColumn(b));
    if (!followers.length) continue;
    const first = Math.min(...followers.map(yOf));
    // Everything under the dropped block in its column moves with the
    // followers — the dropped blocks among them too, so a second hole lower
    // down is measured from where the column now stands.
    const movers = content.filter((b) => yOf(b) > top + 0.5 && inColumn(b));
    // The band is still occupied: a variant drawn in the dropped block's own
    // slot (the masters carry two blocks at one `y`, gated on opposite
    // conditions, and exactly one draws), a row-mate beside it, or a block
    // outside the column that starts between it and the first follower.
    const occupied = drawn.some((b) => {
      const y = yOf(b);
      if (inColumn(b)) return y >= top - 0.5 && y < first - 0.5;
      return y >= top - ROW_MATE_REACH_PT && y < first - 0.5;
    });
    if (occupied) continue;
    const delta = first - top;
    for (const b of movers) shift.set(b.id, (shift.get(b.id) ?? 0) - delta);
  }
  if (!shift.size) return [...blocks];
  return blocks.map((b) => {
    const off = shift.get(b.id);
    if (!off) return b;
    const props = b.props as Record<string, unknown>;
    return { ...b, props: { ...props, y: Number(props.y) + off } } as Block;
  });
}
