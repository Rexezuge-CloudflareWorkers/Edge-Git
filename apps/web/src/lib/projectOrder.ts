/**
 * Pure board-ordering helpers for project cards/columns.
 * Positions are floats; new items append at max+1, moves to an empty column
 * start at 0. Kept UI-side so the same math is unit-tested without D1.
 */

function nextPosition(siblingPositions: number[]): number {
  if (siblingPositions.length === 0) return 0;
  return Math.max(...siblingPositions) + 1;
}

function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0;
  if (before === null) return (after as number) - 1;
  if (after === null) return before + 1;
  if (after <= before) return before + 1;
  return (before + after) / 2;
}

function isValidPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export { nextPosition, positionBetween, isValidPosition };
