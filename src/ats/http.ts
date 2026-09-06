import { AtsFetchError, type AtsProvider, type FetchContext } from './types.js';

/**
 * Shared fetch wrapper for public ATS endpoints.
 *
 * These are unauthenticated public job boards, but we still poll them as a good
 * citizen: honest user-agent, real timeouts, no retry storms. A 403 here almost
 * always means user-agent filtering rather than a missing endpoint (BambooHR
 * does exactly this), so that case is reported distinctly to keep the resolver
 * from marking a live board dead.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait out a rate limit before the single retry.
 *
 * A 429 is the vendor asking us to slow down, not saying the board is gone —
 * but nothing here treated it that way, so a throttled board simply yielded
 * nothing for that hour and recorded a failure. Combined with crawling each
 * vendor in one contiguous block (see interleaveByProvider in corpus/live.ts),
 * that lost most of two entire providers every run.
 *
 * One retry, not a loop: eight workers retrying forever is how polite polling
 * turns into a retry storm, and the crawl runs again in an hour anyway.
 */
const RATE_LIMIT_WAIT_MS = 2_000;
const RATE_LIMIT_WAIT_MAX_MS = 10_000;

/** `Retry-After` is either seconds or an HTTP date. Both appear in the wild. */
function retryAfterMs(header: string | null): number {
  if (!header) return RATE_LIMIT_WAIT_MS;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) {
    return Math.min(secs * 1000, RATE_LIMIT_WAIT_MAX_MS);
  }
  const at = Date.parse(header);
  if (!Number.isNaN(at)) {
    return Math.min(Math.max(at - Date.now(), 0), RATE_LIMIT_WAIT_MAX_MS);
  }
  return RATE_LIMIT_WAIT_MS;
}

async function request(
  url: string,
  provider: AtsProvider,
  token: string,
  ctx: FetchContext,
  init?: RequestInit,
): Promise<Response> {
  const doFetch = ctx.fetchImpl ?? fetch;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);

    try {
      const res = await doFetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'user-agent': ctx.userAgent,
          accept: 'application/json, text/xml;q=0.9, */*;q=0.8',
          ...(init?.headers ?? {}),
        },
      });

      // Wait it out once, then take whatever the second answer is.
      if (res.status === 429 && attempt === 0) {
        clearTimeout(timer);
        await sleep(retryAfterMs(res.headers.get('retry-after')));
        continue;
      }

      return handleStatus(res, provider, token);
    } catch (err) {
      throw asFetchError(err, provider, token, ctx);
    } finally {
      clearTimeout(timer);
    }
  }
}

function handleStatus(res: Response, provider: AtsProvider, token: string): Response {
  if (!res.ok) {
    const hint =
      res.status === 403
        ? ' (403 is usually user-agent filtering, not a dead board — needs the browser tier)'
        : res.status === 404
          ? ' (404 usually means a wrong tenant token, not a dead provider)'
          : res.status === 429
            ? ' (429 is rate limiting — the board is fine, we asked too fast)'
            : '';
    throw new AtsFetchError(
      `${provider}/${token}: HTTP ${res.status}${hint}`,
      provider,
      token,
      res.status,
    );
  }
  return res;
}

function asFetchError(
  err: unknown,
  provider: AtsProvider,
  token: string,
  ctx: FetchContext,
): AtsFetchError {
  if (err instanceof AtsFetchError) return err;
  if (err instanceof Error && err.name === 'AbortError') {
    return new AtsFetchError(
      `${provider}/${token}: timed out after ${ctx.timeoutMs}ms`,
      provider,
      token,
    );
  }
  return new AtsFetchError(
    `${provider}/${token}: ${err instanceof Error ? err.message : String(err)}`,
    provider,
    token,
  );
}

/**
 * Applies the same deadline to reading the body as to getting the headers.
 *
 * `request()` clears its abort timer in a `finally` as soon as the Response is
 * returned, which happens before anything reads the body. A vendor that sent
 * headers and then stalled mid-body hung the crawl forever — ctx.timeoutMs never
 * applied to the part that was actually stuck.
 */
async function withDeadline<T>(
  work: Promise<T>,
  provider: AtsProvider,
  token: string,
  ctx: FetchContext,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AtsFetchError(
            `${provider}/${token}: body read timed out after ${ctx.timeoutMs}ms`,
            provider,
            token,
          ),
        ),
      ctx.timeoutMs,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function getJson<T>(
  url: string,
  provider: AtsProvider,
  token: string,
  ctx: FetchContext,
): Promise<T> {
  const res = await request(url, provider, token, ctx);
  return (await withDeadline(res.json(), provider, token, ctx)) as T;
}

/**
 * A JSON POST, for boards that will not answer a GET.
 *
 * UKG's job board is one: the listing is a search endpoint that takes a body
 * with paging in it. Routed through `request` like everything else so the
 * timeout, the user agent and the error handling stay identical whichever verb
 * a vendor happens to require.
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  provider: AtsProvider,
  token: string,
  ctx: FetchContext,
): Promise<T> {
  const res = await request(url, provider, token, ctx, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await withDeadline(res.json(), provider, token, ctx)) as T;
}

export async function getText(
  url: string,
  provider: AtsProvider,
  token: string,
  ctx: FetchContext,
): Promise<string> {
  const res = await request(url, provider, token, ctx);
  return await withDeadline(res.text(), provider, token, ctx);
}
