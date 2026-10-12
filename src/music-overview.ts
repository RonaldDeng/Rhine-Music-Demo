import * as THREE from "three";
import { damp } from "./motion.ts";

/** A shared transition drives camera framing and real-column centering. */
export class MusicOverviewMotion {
  private progress = { value: 0, velocity: 0 };
  active = false;
  get value() { return THREE.MathUtils.clamp(this.progress.value, 0, 1); }
  update(dt: number, reduced: boolean) {
    if (reduced) this.progress = { value: Number(this.active), velocity: 0 };
    else damp(this.progress, Number(this.active), 6.5, Math.max(0, dt));
    return this.value;
  }
  reset() { this.active = false; this.progress = { value: 0, velocity: 0 }; }
}

export function overviewFraming(width: number, height: number) {
  const aspect = Math.max(1, width) / Math.max(1, height);
  // Aim one physical column to the right, placing the unchanged selection left.
  // Show about five columns in landscape and three on narrow portrait screens.
  return { span: Math.max(16.8, 18.5 / aspect), distance: 172, yaw: 28, elevation: 43, aimColumns: 1 };
}

export interface OverviewColumn {
  lane: number;
  /** World identity of a repeated column, stable across local coordinate rebases. */
  physicalLane?: number;
  name: string;
  count: number;
  x: number;
  y: number;
  selected: boolean;
  /** Shared physical edge visibility; omitted by static projection fixtures. */
  extent?: number;
  /** Remaining lane distance before this repeated physical copy is replaced. */
  copyClearance?: number;
}

/** Geometry is fixed for the viewport, never derived from neighbouring columns. */
export function overviewLabelMetrics(width: number) {
  return { width: width < 600 ? 104 : 144, height: width < 600 ? 42 : 46, entry: 32, stem: 18 };
}

interface OverviewRect { left: number; right: number; top: number; bottom: number }
export interface OverviewBounds { top: number; bottom: number; obstacles?: OverviewRect[] }

function labelRects(column: OverviewColumn, width: number): OverviewRect[] {
  const size = overviewLabelMetrics(width);
  return [
    { left: column.x - size.width / 2, right: column.x + size.width / 2 + size.entry,
      top: column.y - size.height, bottom: column.y },
    { left: column.x, right: column.x + 1, top: column.y, bottom: column.y + size.stem },
  ];
}
function rectClearance(a: OverviewRect, b: OverviewRect) {
  return Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom);
}

/** Space around the complete card, reserved arrow and leader. */
export function overviewBoundaryClearance(column: OverviewColumn, width: number, height: number,
  bounds: OverviewBounds = { top: 115, bottom: height - 112 }) {
  if (!Number.isFinite(column.x) || !Number.isFinite(column.y)) return -Infinity;
  const size = overviewLabelMetrics(width);
  let distance = Math.min(column.x - size.width / 2 - 12,
    width - 12 - column.x - size.width / 2 - size.entry,
    column.y - size.height - bounds.top, bounds.bottom - column.y - size.stem);
  for (const obstacle of bounds.obstacles ?? []) for (const rect of labelRects(column, width))
    distance = Math.min(distance, rectClearance(rect, obstacle) - 16);
  return distance;
}

/** Binary emergency guard during exit, never a persistent opacity target. */
export function overviewLabelOpacity(column: OverviewColumn, width: number, height: number,
  bounds: OverviewBounds = { top: 115, bottom: height - 112 }) {
  return Number((column.extent ?? 1) > 0 && overviewBoundaryClearance(column, width, height, bounds) > 0);
}

/** Positive separation of the complete reserved footprints, in CSS pixels. */
export function overviewLabelClearance(a: OverviewColumn, b: OverviewColumn, width: number) {
  // A leader is one pixel wide, not a full-width extension of the card.
  // Using the enclosing rectangle needlessly hides ordinary diagonal neighbours.
  return Math.min(...labelRects(a, width).flatMap(first =>
    labelRects(b, width).map(second => rectClearance(first, second))));
}

export function overviewCollisionOpacity(a: OverviewColumn, b: OverviewColumn, width: number) {
  return Number(overviewLabelClearance(a, b, width) > 0);
}

/** V0.4.1's single projection model: select labels, never relocate their anchors.
 * Expanded/selected names come first; other retained names keep precedence.
 * Geometry decides membership; only the finite card transition controls alpha.
 * Distinct entry/exit thresholds prevent chatter without leaving faint names. */
export function visibleOverviewLabels(columns: OverviewColumn[], width: number, height: number,
  retained: ReadonlySet<number> = new Set(), expandedLane: number | null = null,
  bounds: OverviewBounds = { top: 115, bottom: height - 112 },
  forecasts: ReadonlyMap<number, OverviewColumn>[] = []): OverviewColumn[] {
  const accepted: OverviewColumn[] = [];
  const ordered = [...columns].sort((a, b) =>
    Number(b.lane === expandedLane) - Number(a.lane === expandedLane) ||
    Number(b.selected) - Number(a.selected) ||
    Number(retained.has(b.lane)) - Number(retained.has(a.lane)) ||
    // Stable physical order for retained labels, independent of camera height.
    (retained.has(a.lane) && retained.has(b.lane) ? a.lane - b.lane :
      Number(b.selected) - Number(a.selected) || Math.abs(a.x - width / 2) - Math.abs(b.x - width / 2)));
  for (const column of ordered) {
    const keep = retained.has(column.lane);
    // A folding pool-edge occurrence does not receive a detached name card.
    if ((column.extent ?? 1) <= (keep ? .98 : .995)) continue;
    if (overviewBoundaryClearance(column, width, height, bounds) <= (keep ? 4 : 8)) continue;
    // Reserve the finite exit before contact, folding or a repeated-copy swap.
    // Forecasts decide membership only; the returned anchor is always current.
    if (forecasts.some(forecast => {
      const future = forecast.get(column.lane) ?? column;
      return (future.extent ?? 1) <= (keep ? .98 : .995) ||
        (future.copyClearance ?? Infinity) <= 0 ||
        overviewBoundaryClearance(future, width, height, bounds) <= 0;
    })) continue;
    if (accepted.some(other => overviewLabelClearance(column, other, width) <= (keep ? 8 : 10) ||
      forecasts.some(forecast => overviewLabelClearance(forecast.get(column.lane) ?? column,
        forecast.get(other.lane) ?? other, width) <= 0))) continue;
    accepted.push(column);
  }
  return accepted;
}
