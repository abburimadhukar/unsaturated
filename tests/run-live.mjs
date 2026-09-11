/**
 * Runs the live-database tests — the ones that query production.
 *
 *   npm run test:live
 *
 * Separate from `npm test` on purpose. Those tests page through every open
 * posting while hourly crawls write to the same table, so they cannot give a
 * stable answer: four consecutive runs on 10 Sep 2026 against identical code
 * went 25/0, 24/1, 9/0 and 18/7. Leaving them in the default suite meant a red
 * run could not distinguish a broken change from a moved number.
 *
 * Two things this does that `node --test` on its own would not:
 *
 *   LIVE_DB=1            opts in. Without it every live test skips with a reason.
 *   concurrency = 1      runs files one at a time. Part of the instability was
 *                        test files racing each other for the same database —
 *                        the reachability probe returned null under that load,
 *                        and all 25 tests skipped while reporting a schema fault.
 *
 * A runner script rather than an inline env var because `LIVE_DB=1 node ...` is
 * sh syntax and this project is developed on Windows, where it is a parse error.
 */
import { spawn } from 'node:child_process';

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', 'tests/*.test.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, LIVE_DB: '1' },
    // The glob is expanded by Node itself, not by a shell.
    shell: false,
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`\ntest:live was killed by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
