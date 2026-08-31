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

    if (!res.ok) {
      const hint =
        res.status === 403
          ? ' (403 is usually user-agent filtering, not a dead board — needs the browser tier)'
          : res.status === 404
            ? ' (404 usually means a wrong tenant token, not a dead provider)'
            : '';
      throw new AtsFetchError(
        `${provider}/${token}: HTTP ${res.status}${hint}`,
        provider,
        token,
        res.status,
      );
    }
    return res;
  } catch (err) {
    if (err instanceof AtsFetchError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AtsFetchError(`${provider}/${token}: timed out after ${ctx.timeoutMs}ms`, provider, token);
    }
    throw new AtsFetchError(
      `${provider}/${token}: ${err instanceof Error ? err.message : String(err)}`,
      provider,
      token,
    );
  } finally {
    clearTimeout(timer);
  }
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

export async function getText(
  url: string,
  provider: AtsProvider,
  token: string,
  ctx: FetchContext,
): Promise<string> {
  const res = await request(url, provider, token, ctx);
  return await withDeadline(res.text(), provider, token, ctx);
}
