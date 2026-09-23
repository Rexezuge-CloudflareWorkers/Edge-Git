/**
 * Pure pack-budget predicates (Otter pure-helper pattern).
 *
 * Extracted from `PackCollector.collectObjectsForPack` so limit checks are
 * unit testable without isomorphic-git. `PackLimitError` canonical home is
 * this module; `PackCollector` keeps a single compat re-export and the
 * package barrel re-exports from here directly.
 */
class PackLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackLimitError';
  }
}

function checkObjectBudget(input: { objectsToSend: number; visited: number; maxObjects?: number; maxVisited: number }): void {
  if (input.maxObjects !== undefined && input.objectsToSend > input.maxObjects) {
    throw new PackLimitError(`too many objects: limit is ${input.maxObjects}`);
  }
  if (input.visited > input.maxVisited || input.objectsToSend > input.maxVisited) {
    throw new PackLimitError('rev-walk too large');
  }
}

function maxVisitedFor(maxObjects?: number): number {
  return (maxObjects ?? 10_000) * 4 + 1000;
}

export { PackLimitError, checkObjectBudget, maxVisitedFor };
