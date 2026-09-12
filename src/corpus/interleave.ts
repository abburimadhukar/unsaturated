/**
 * Spreading work evenly across vendors instead of doing them in blocks.
 *
 * Used for TWO separate problems that turn out to be the same shape.
 *
 * FIRST: NOT HAMMERING ONE VENDOR
 *
 * The registry comes back ordered by (provider, token), and the worker pool
 * walks that order — so all eight workers sat on ONE vendor at a time, times
 * four shards, which is up to 32 simultaneous requests at a single company.
 * Measured result: 42% of Workable boards and 66% of Recruitee boards were
 * carrying HTTP 429 at any moment, yielding 0.26 and 0.25 jobs per board
 * against Workday's 9.00. We were storing 3,014 Workable boards and reading
 * almost none of them.
 *
 * SECOND: NOT STARVING ONE VENDOR OF A BUDGET
 *
 * The embedding budget takes the head of a list and defers the rest. Measured
 * on the live database, 12 September 2026, after the first run that embedded
 * anything:
 *
 *   workday          31,390 open      3,415 embedded    10.9%
 *   greenhouse       13,455 open          0 embedded     0.0%
 *   ashby             5,776 open          0 embedded     0.0%
 *   ...all 11 others                      0 embedded     0.0%
 *
 * Every one of the 3,990 vectors was Workday, because the crawl sorts its jobs
 * by saturation before the budget is applied and the highest-saturation vendor
 * therefore occupies the entire head of the list, every run. With 31,390
 * Workday jobs queued ahead of them the others would have waited days. That is
 * not a race that settles — it is deterministic starvation, and it made a
 * "match score" that could only ever match one vendor's postings.
 *
 * HOW
 *
 * Each item is placed at its fractional position within its own provider, and
 * the whole list is sorted by that. A provider with 5,271 boards and one with
 * 525 both end up smeared across the entire list, so consecutive items are
 * nearly always different vendors and no vendor ever sees a burst.
 *
 * Plain round-robin would not do this: it drains the small providers early and
 * leaves a long single-vendor tail, which is the same problem again at the end.
 *
 * The fractional placement also gives the budget case the property it wants.
 * Taking the first N of this order hands each provider a share proportional to
 * how much work it has, so every provider starts making progress immediately
 * AND they all reach completion at roughly the same time. Equal shares would
 * finish the small vendors quickly and leave the largest one last, which is the
 * starvation above with a longer fuse.
 *
 * Deterministic — same input, same order — so a shard still covers exactly the
 * boards it covered before, and the split stays reproducible.
 */
export function interleaveByProvider<T extends { provider: string }>(items: T[]): T[] {
  const seen = new Map<string, number>();
  const sizes = new Map<string, number>();
  for (const b of items) sizes.set(b.provider, (sizes.get(b.provider) ?? 0) + 1);

  return items
    .map((item) => {
      const i = seen.get(item.provider) ?? 0;
      seen.set(item.provider, i + 1);
      // +0.5 centres each item in its slot, so two providers of the same size
      // interleave rather than colliding on identical positions.
      return { item, at: (i + 0.5) / (sizes.get(item.provider) ?? 1) };
    })
    .sort((a, b) => a.at - b.at)
    .map((x) => x.item);
}
