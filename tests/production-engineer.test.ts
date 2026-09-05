import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRole } from '../src/taxonomy/families.js';
import type { NormalizedJob } from '../src/ats/types.js';

/**
 * "Production Engineer" is two unrelated jobs sharing one name.
 *
 * At a software company it keeps the service running — the same work as an SRE.
 * At a factory it keeps the line running. Measured across the corpus: 73
 * postings, 66 filed as cloud, and 51 of those with no cloud tool anywhere in
 * their description. Blue Origin's "Production Engineer III", ASML's "NXE 2nd
 * Shift Production Engineer" and Entegris' bare "Production Engineer" were all
 * sitting in the Cloud family.
 *
 * The title alone cannot separate them — Entegris and CoreWeave spell it
 * identically — so it needs a reason to believe.
 */

const job = (title: string, body = ''): NormalizedJob =>
  ({ title, descriptionText: body }) as NormalizedJob;
const family = (title: string, body = '') => classifyRole(job(title, body)).family;

// ---------------------------------------------------------------------------
// Factory roles must leave the Cloud family
// ---------------------------------------------------------------------------

for (const title of [
  'Mechanical Production Engineer',
  'Mechanical Production Engineer Level 2 / 3',
  'NXE 2nd Shift Production Engineer First Line Support',
  'EXE FLS Production Engineer - Mechanical Competence',
  'Additive Manufacturing Production Engineer',
  'Production Engineer (Electrical Test) - Robotics',
  'Production Engineer, Assembly',
  'Production Engineer - CNC Machining',
  'Production Engineer, Semiconductor Wafer Fab',
  // Slipped through a first attempt: "Laser system" contains the word "system",
  // which had been treated as evidence of an IT role. It is in the name of
  // nearly every piece of factory equipment ever built.
  'Production Engineer (DUV Laser system)',
]) {
  test(`"${title}" is not a cloud role`, () => {
    assert.notEqual(family(title), 'cloud');
  });
}

test('a bare Production Engineer with no evidence is not guessed at', () => {
  // Entegris, Danaher, Halma, Blue Origin all post exactly this, and all of them
  // are factories. With nothing to go on, staying out of Cloud is the honest
  // answer; the review queue can hold it until a description arrives.
  assert.notEqual(family('Production Engineer'), 'cloud');
  assert.notEqual(family('Production Engineer III'), 'cloud');
  assert.notEqual(family('Production Engineer (all genders)'), 'cloud');
});

// ---------------------------------------------------------------------------
// Real ones must stay
// ---------------------------------------------------------------------------

for (const title of [
  'Senior Production Engineer - SRE',
  'Infrastructure Production Engineer',
  'Senior Network Production Engineer, Network Ops',
  'Production Engineer, Network',
  'Cloud Production Engineer',
  'Software Production Engineer',
  'Site Reliability Production Engineer',
  'Bioinformatics Production Engineer',
]) {
  test(`"${title}" stays a cloud role`, () => {
    assert.equal(family(title), 'cloud');
  });
}

test('a bare title is rescued by cloud tools in the description', () => {
  // This is what separates Entegris from CoreWeave, where the titles are
  // identical and only the description differs.
  assert.notEqual(family('Production Engineer'), 'cloud');
  assert.equal(family('Production Engineer', 'kubernetes terraform aws linux observability'), 'cloud');
});

test('a manufacturing word beats cloud tools in the description', () => {
  // A factory that runs Linux on its machines is still a factory. The title is
  // the stronger signal when it names a discipline outright.
  assert.notEqual(family('Mechanical Production Engineer', 'linux docker aws'), 'cloud');
});

test('another cloud claim in the title survives on its own', () => {
  // The guard only skips when "production engineer" was the ONLY reason cloud
  // matched. A title that is also a DevOps or SRE role keeps its claim.
  assert.equal(family('DevOps / Production Engineer'), 'cloud');
  assert.equal(family('Production Engineer & Kubernetes Administrator'), 'cloud');
});
