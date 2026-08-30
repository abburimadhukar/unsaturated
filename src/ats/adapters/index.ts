import { ashbyAdapter } from './ashby.js';
import { breezyAdapter } from './breezy.js';
import { greenhouseAdapter } from './greenhouse.js';
import { leverAdapter } from './lever.js';
import { personioAdapter } from './personio.js';
import { smartRecruitersAdapter } from './smartrecruiters.js';
import { workableAdapter } from './workable.js';
import { workdayAdapter } from './workday.js';
import { ripplingAdapter } from './rippling.js';
import { usajobsAdapter } from './usajobs.js';
import { socrataAdapter } from './socrata.js';
import type { AtsAdapter, AtsProvider } from '../types.js';

/**
 * Every provider whose public endpoint has been verified working without auth.
 *
 * Adding a provider is a one-file change: implement AtsAdapter, register it here,
 * and teach the resolver its URL shape. Nothing downstream of NormalizedJob has
 * any provider-specific knowledge.
 */
export const ADAPTERS: Record<AtsProvider, AtsAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workable: workableAdapter,
  smartrecruiters: smartRecruitersAdapter,
  breezy: breezyAdapter,
  personio: personioAdapter,
  workday: workdayAdapter,
  rippling: ripplingAdapter,
  usajobs: usajobsAdapter,
  socrata: socrataAdapter,
};

export function getAdapter(provider: AtsProvider): AtsAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`No adapter registered for provider: ${provider}`);
  return adapter;
}

export const SUPPORTED_PROVIDERS = Object.keys(ADAPTERS) as AtsProvider[];
