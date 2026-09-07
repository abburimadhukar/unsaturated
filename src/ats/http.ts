import {
  AtsFetchError,
  failureKindFor,
  type AtsProvider,
  type FetchContext,
  type RefusalDetail,
} from './types.js';

/**
 * Shared fetch wrapper for public ATS endpoints.
 *
 * These are unauthenticated public job boards, but we still poll them as a good
 * citizen: honest user-agent, real timeouts, no retry storms. A 403 here almost
 * always means user-agent filtering rather than a missing endpoint (BambooHR
 * does exactly this), so that case is reported distinctly to keep the resolver
 * from marking a live board dead.
 */
/**
 * No retry here, deliberately — and this is a correction, not an omission.
 *
 * A retry-once on 429 was added this morning and made things measurably worse.
 * Across three thousand Workable boards it sent a second request to the one
 * vendor that had just asked us to slow down, so failures went from 42% to
 * 90%, and the boards then walked into retirement five failures at a time.
 * 2,157 live companies were switched off that way in an afternoon.
 *
 * Retrying is the right instinct for ONE unlucky request and exactly the wrong
 * one at scale: it converts a rate limit into a load problem. Backing off is
 * what a rate limit asks for, so the response lives in the per-provider limiter
 * (src/corpus/rate-limit.ts) which slows every subsequent request to that
 * vendor instead of hurrying this one.
 *
 * The crawl runs again in an hour. A board skipped now is read then, and
 * nothing about it is recorded as a failure in the meantime.
 */

/** How long the vendor asked us to wait, when it says. */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 60_000);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), 60_000);
  return null;
}

async function request(
  url: string,
  provider: AtsProvider,
  token: string,
  ctx: FetchContext,
  init?: RequestInit,
): Promise<Response> {
  const doFetch = ctx.fetchImpl ?? fetch;
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
    return await handleStatus(res, provider, token);
  } catch (err) {
    throw asFetchError(err, provider, token, ctx);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a refusal for what it actually says.
 *
 * Only on the error path, so it costs nothing on a healthy crawl — and error
 * bodies are small. This exists because a status code alone has not been enough
 * to explain why one vendor refuses from a datacenter and not from a laptop.
 */
async function refusalDetail(res: Response): Promise<RefusalDetail> {
  const limitHeaders: Record<string, string> = {};
  for (const [k, v] of res.headers) {
    if (/^(x-)?rate-?limit|^retry-after$|^x-ratelimit/i.test(k)) limitHeaders[k.toLowerCase()] = v;
  }
  let body: string | undefined;
  try {
    body = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim() || undefined;
  } catch {
    // A body we cannot read is not worth failing over.
  }
  return {
    status: res.status,
    ...(res.headers.get('retry-after') ? { retryAfter: res.headers.get('retry-after')! } : {}),
    ...(Object.keys(limitHeaders).length ? { limitHeaders } : {}),
    ...(body ? { body } : {}),
  };
}

async function handleStatus(
  res: Response,
  provider: AtsProvider,
  token: string,
): Promise<Response> {
  if (!res.ok) {
    const hint =
      res.status === 403
        ? ' (403 is usually user-agent filtering, not a dead board — needs the browser tier)'
        : res.status === 404
          ? ' (404 usually means a wrong tenant token, not a dead provider)'
          : res.status === 429
            ? ' (429 is rate limiting — the board is fine, we asked too fast)'
            : '';
    const kind = failureKindFor(res.status);
    throw new AtsFetchError(
      `${provider}/${token}: HTTP ${res.status}${hint}`,
      provider,
      token,
      res.status,
      kind,
      // Only for refusals. A 404 has nothing to explain.
      kind === 'refused' ? await refusalDetail(res) : undefined,
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
  // A timeout or a dropped connection tells us about the network, never about
  // the board — so both default to 'refused' and neither counts toward
  // retirement.
  if (err instanceof Error && err.name === 'AbortError') {
    return new AtsFetchError(
      `${provider}/${token}: timed out after ${ctx.timeoutMs}ms`,
      provider,
      token,
      undefined,
      'refused',
    );
  }
  return new AtsFetchError(
    `${provider}/${token}: ${err instanceof Error ? err.message : String(err)}`,
    provider,
    token,
    undefined,
    'refused',
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
