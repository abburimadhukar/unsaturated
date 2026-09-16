import { test } from 'node:test';
import assert from 'node:assert/strict';

import { closableBoards } from '../src/corpus/db-feed.js';
import { sliceForShard } from '../src/corpus/live.js';

/**
 * Every career site of one employer is crawled by the same shard.
 *
 * closableBoards closes a token's postings only when every board under that
 * token came back healthy — but a shard can only judge the boards it holds.
 * Split across shards, each shard saw one healthy site of a tenant and closed
 * the others' postings as withdrawn. Measured 16 September 2026: multi-site
 * Workday tenants closed 170.8 postings per 100 open in 48 hours, against 15.1
 * for single-site ones.
 */

type B = { provider: string; token: string; site: string };
const b = (provider: string, token: string, site = ''): B => ({ provider, token, site });

const OF = 4;
const shards = (items: B[]) => Array.from({ length: OF }, (_, index) => sliceForShard(items, { index, of: OF }));

// The shape the registry really has: interleaved by provider, with one
// tenant's sites NOT adjacent — which is exactly what split them before.
const REGISTRY: B[] = [
  b('workday', 'nshe', 'GBC-external'),
  b('greenhouse', 'stripe'),
  b('oracle', 'hdga', 'CX'),
  b('ashby', 'acme'),
  b('greenhouse', 'airbnb'),
  b('workday', 'nshe', 'UNR-external'),
  b('oracle', 'hdga', 'CX_1'),
  b('ashby', 'beta'),
  b('oracle', 'hdga', 'CX_2'),
  b('workday', 'fmr', 'FidelityCareers'),
  b('greenhouse', 'Stripe'), // case variant: the registry treats it as the same tenant
];

test('every board is crawled exactly once', () => {
  const all = shards(REGISTRY).flat();
  assert.equal(all.length, REGISTRY.length);
  assert.equal(new Set(all).size, REGISTRY.length);
});

test('all sites of one tenant land in the same shard', () => {
  const where = new Map<string, Set<number>>();
  shards(REGISTRY).forEach((slice, i) => {
    for (const x of slice) {
      const t = `${x.provider}:${x.token.toLowerCase()}`;
      where.set(t, (where.get(t) ?? new Set()).add(i));
    }
  });
  for (const [tenant, set] of where) {
    assert.equal(set.size, 1, `${tenant} is split across shards ${[...set].join(', ')}`);
  }
});

test('a shard can no longer close a sibling site it did not read', () => {
  // The failure itself, end to end through the real close rule: in the shard
  // that holds nshe, BOTH campuses are present, so one refusing protects both.
  for (const slice of shards(REGISTRY)) {
    const nshe = slice.filter((x) => x.token === 'nshe');
    if (nshe.length === 0) continue;
    assert.equal(nshe.length, 2, 'the shard holding nshe must hold both campuses');
    const closable = closableBoards([
      { provider: 'workday', token: 'nshe', jobs: 18 },
      { provider: 'workday', token: 'nshe', jobs: 0, error: new Error('429') },
    ]);
    assert.equal(closable.has('workday:nshe'), false);
  }
});

test('the split stays balanced over a realistic registry', () => {
  // Round-robin over tenants, so the shards differ by at most the extra sites
  // one tenant carries — a handful against thousands.
  const big: B[] = [];
  for (let i = 0; i < 4000; i++) big.push(b('greenhouse', `g${i}`));
  for (let i = 0; i < 300; i++) {
    big.push(b('workday', `w${i}`, 'External'));
    if (i % 5 === 0) big.push(b('workday', `w${i}`, 'Internal'));
  }
  const sizes = shards(big).map((s) => s.length);
  const spread = Math.max(...sizes) - Math.min(...sizes);
  assert.ok(spread <= 30, `shard sizes ${sizes.join(', ')} are uneven`);
});

test('an unsharded run is untouched', () => {
  assert.equal(sliceForShard(REGISTRY), REGISTRY);
  assert.equal(sliceForShard(REGISTRY, { index: 0, of: 1 }), REGISTRY);
});
