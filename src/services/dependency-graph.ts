/**
 * Generic DAG solver for computing execution waves.
 * Used for milestones, slices, and tasks.
 * ID type is generic — works with both numeric IDs and string slugs.
 */
export interface DependencyItem<ID = string> {
  id: ID;
  depends: ID[];
  status?: string;
}

export interface Wave<ID = string> {
  wave: number;
  ids: ID[];
}

export function computeWaves<ID>(items: DependencyItem<ID>[]): Wave<ID>[] {
  const waves: Wave<ID>[] = [];
  const completed = new Set<ID>();
  const remaining = new Map<ID, ID[]>(items.map(i => [i.id, i.depends]));

  let wave = 0;
  while (remaining.size > 0) {
    const ready: ID[] = [];
    for (const [id, deps] of remaining) {
      if (deps.every(d => completed.has(d))) {
        ready.push(id);
      }
    }
    if (ready.length === 0) {
      // Circular dependency — break by adding all remaining
      console.warn("Circular dependency detected, force-completing remaining items:", [...remaining.keys()]);
      ready.push(...remaining.keys());
    }
    for (const id of ready) {
      remaining.delete(id);
      completed.add(id);
    }
    waves.push({ wave: wave++, ids: ready });
  }

  return waves;
}

/**
 * Get items that are ready to execute (all deps completed).
 */
export function getReadyItems<ID>(items: DependencyItem<ID>[]): ID[] {
  const completedIds = new Set(items.filter(i => i.status === "completed").map(i => i.id));
  const activeOrPending = items.filter(i => i.status !== "completed" && i.status !== "failed");

  return activeOrPending
    .filter(i => i.depends.every(d => completedIds.has(d)))
    .map(i => i.id);
}
