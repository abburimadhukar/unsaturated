/**
 * Merges boards that are the same company spelled two ways.
 *
 *   npm run boards:dedupe -- --dry-run    report what would merge
 *   npm run boards:dedupe                 merge them
 *
 * The web archive holds both `greenhouse.io/babylist` and
 * `greenhouse.io/Babylist`, and until now the registry stored each as a
 * separate board because the dedup key was case-sensitive. These APIs are not:
 * verified 7 Sep 2026, ashby/accord and ashby/Accord both return the same 4
 * jobs, greenhouse/babylist and greenhouse/Babylist the same 46,
 * smartrecruiters/bluescope and smartrecruiters/BlueScope the same 37.
 *
 * A job key is provider:token:id, so both copies stored the SAME posting under
 * different keys and both reached the site. AbbVie appears twice with 41 jobs
 * each; a Staff Software Engineer at Accord is listed twice today. 317 such
 * pairs exist — 233 Ashby, 36 Greenhouse, 25 SmartRecruiters, 23 UKG.
 *
 * harvest-cc no longer creates them. This clears the ones already made.
 *
 * The survivor is the copy holding the most stored jobs, because that is the
 * one the site is already showing and moving people to the other spelling
 * changes nothing they can see. Ties break on the token itself so two runs
 * always agree.
 */
import { dbWrite } from '../db/supabase.js';

const PAGE = 1000;

interface Board {
  provider: string;
  token: string;
  active: boolean;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const client = dbWrite();

  const boards: Board[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('boards')
      .select('provider,token,active')
      .eq('active', true)
      .order('provider', { ascending: true })
      .order('token', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`could not read boards: ${error.message}`);
    const batch = (data ?? []) as unknown as Board[];
    boards.push(...batch);
    if (batch.length < PAGE) break;
  }

  // Group by what the vendor actually treats as one identity.
  const groups = new Map<string, string[]>();
  for (const b of boards) {
    const key = `${b.provider}:${b.token.toLowerCase()}`;
    groups.set(key, (groups.get(key) ?? []).concat(b.token));
  }
  const dupes = [...groups].filter(([, tokens]) => tokens.length > 1);

  if (dupes.length === 0) {
    console.log('No case-variant duplicates. Nothing to merge.');
    return;
  }

  console.log(`${dupes.length} companies are registered under more than one spelling.\n`);

  let merged = 0;
  let closed = 0;
  const byProvider = new Map<string, number>();

  for (const [key, tokens] of dupes) {
    const provider = key.slice(0, key.indexOf(':'));
    byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1);

    // How many stored jobs each spelling is currently carrying.
    const counts = await Promise.all(
      tokens.map(async (token) => {
        const { count } = await client
          .from('jobs')
          .select('key', { count: 'exact', head: true })
          .eq('provider', provider)
          .eq('board_token', token)
          .is('closed_at', null);
        return { token, jobs: count ?? 0 };
      }),
    );

    // Most jobs wins; the token itself breaks a tie so this is reproducible.
    counts.sort((a, b) => b.jobs - a.jobs || a.token.localeCompare(b.token));
    const keep = counts[0]!;
    const drop = counts.slice(1);

    if (dryRun) {
      console.log(
        `  ${provider}/${keep.token} (${keep.jobs} jobs) ` +
          `absorbs ${drop.map((d) => `${d.token} (${d.jobs})`).join(', ')}`,
      );
      continue;
    }

    for (const d of drop) {
      // Close its postings first. Deactivating alone would leave the duplicates
      // on the site for the full retention window, which is the whole problem.
      const { error: closeErr, count: n } = await client
        .from('jobs')
        .update({ closed_at: new Date().toISOString() }, { count: 'exact' })
        .eq('provider', provider)
        .eq('board_token', d.token)
        .is('closed_at', null);
      if (closeErr) {
        console.error(`could not close ${provider}/${d.token}: ${closeErr.message}`);
        continue;
      }
      closed += n ?? 0;

      const { error: offErr } = await client
        .from('boards')
        .update({ active: false, last_error: `duplicate spelling of ${keep.token}` })
        .eq('provider', provider)
        .eq('token', d.token);
      if (offErr) {
        console.error(`could not deactivate ${provider}/${d.token}: ${offErr.message}`);
        continue;
      }
      merged++;
    }
  }

  console.log('\nby provider:');
  for (const [p, n] of [...byProvider].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(18)} ${n}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }
  console.log(`\nMerged ${merged} duplicate boards and closed ${closed} duplicate postings.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
