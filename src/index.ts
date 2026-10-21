interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * EMA Medicines MCP — the European Medicines Agency's public medicines register.
 *
 * Auth: none.
 *
 * Source shape (all of it learned the hard way, keep it written down):
 *  - The register is published as ONE machine-generated XLSX, regenerated daily
 *    (~18:00 CET). Stable URL, stable 39-column schema, honest `Last-Modified`.
 *  - Sheet `Medicine`: row 1 is a provenance banner, rows 2–8 are blank,
 *    ROW 9 IS THE HEADER, rows 10+ are records.
 *  - The header row uses inline strings, not shared strings.
 *  - Dates are DD/MM/YYYY. Everything below converts to ISO on the way out.
 *  - ema.europa.eu rate-limits bursts and answers a 429 with ~40 KB of HTML, so
 *    a per-call download is not viable. One download feeds every tool call for
 *    six hours (see DATASET_TTL_MS), and the Cloudflare edge cache absorbs the
 *    repeat downloads on top of that.
 *  - data.europa.eu still lists the EMA datasets, but they are frozen at 2019
 *    and every distribution URL 404s. It is not a usable route to this data.
 */

import { parseSharedStrings, scanSheet, unzipText } from './xlsx.js';

// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'EMA Medicines');
}

const XLSX_URL =
  'https://www.ema.europa.eu/en/documents/report/medicines-output-medicines-report_en.xlsx';
const UA = 'pipeworx-mcp-ema-medicines/1.0 (+https://pipeworx.io)';
const SOURCE = 'European Medicines Agency — medicines register (medicines-output-medicines-report_en.xlsx)';

/** The register is regenerated once a day, so six hours is exact, not stale. */
const DATASET_TTL_MS = 6 * 60 * 60 * 1000;
const HEADER_ROW = 9;

/** Header text (whitespace-collapsed) → the field name callers see. */
const FIELDS: Record<string, string> = {
  'Category': 'category',
  'Name of medicine': 'name',
  'EMA product number': 'ema_product_number',
  'Medicine status': 'medicine_status',
  'Opinion status': 'opinion_status',
  'Latest procedure affecting product information': 'latest_procedure',
  'International non-proprietary name (INN) / common name': 'inn',
  'Active substance': 'active_substance',
  'Therapeutic area (MeSH)': 'therapeutic_area',
  'Species (veterinary)': 'species',
  'Patient safety': 'patient_safety',
  'ATC code (human)': 'atc_code',
  'ATCvet code (veterinary)': 'atcvet_code',
  'Pharmacotherapeutic group (human)': 'pharmacotherapeutic_group',
  'Pharmacotherapeutic group (veterinary)': 'pharmacotherapeutic_group_vet',
  'Therapeutic indication': 'therapeutic_indication',
  'Accelerated assessment': 'accelerated_assessment',
  'Additional monitoring': 'additional_monitoring',
  'Advanced therapy': 'advanced_therapy',
  'Biosimilar': 'biosimilar',
  'Conditional approval': 'conditional_approval',
  'Exceptional circumstances': 'exceptional_circumstances',
  'Generic': 'generic',
  'Orphan medicine': 'orphan_medicine',
  'PRIME: priority medicine': 'prime_priority_medicine',
  'Marketing authorisation developer / applicant / holder': 'holder',
  'European Commission decision date': 'ec_decision_date',
  'Start of rolling review date': 'rolling_review_start_date',
  'Start of evaluation date': 'evaluation_start_date',
  'Opinion adopted date': 'opinion_adopted_date',
  'Withdrawal of application date': 'application_withdrawal_date',
  'Marketing authorisation date': 'marketing_authorisation_date',
  'Refusal of marketing authorisation date': 'refusal_date',
  'Withdrawal / expiry / revocation / lapse of marketing authorisation date': 'authorisation_end_date',
  'Suspension of marketing authorisation date': 'suspension_date',
  'Revision number': 'revision_number',
  'First published date': 'first_published_date',
  'Last updated date': 'last_updated_date',
  'Medicine URL': 'url',
};

const DATE_FIELDS = new Set([
  'ec_decision_date',
  'rolling_review_start_date',
  'evaluation_start_date',
  'opinion_adopted_date',
  'application_withdrawal_date',
  'marketing_authorisation_date',
  'refusal_date',
  'authorisation_end_date',
  'suspension_date',
  'first_published_date',
  'last_updated_date',
]);

export type Medicine = Record<string, string>;

interface Dataset {
  medicines: Medicine[];
  fetchedAt: number;
  lastModified: string | null;
}

let CACHE: Dataset | null = null;
let INFLIGHT: Promise<Dataset> | null = null;

function slugField(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toIso(ddmmyyyy: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : ddmmyyyy;
}

async function load(): Promise<Dataset> {
  let res: Response;
  try {
    res = await pwFetch(XLSX_URL, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      // Six hours at the edge on top of the in-process cache, so a cold isolate
      // in a busy colo still does not go back to ema.europa.eu.
      cf: {
        cacheTtlByStatus: { '200-299': 21600, '400-499': 60, '500-599': 10 },
        cacheEverything: true,
      },
    } as RequestInit);
  } catch (e) {
    throw new Error(`ema_fetch_failed:${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`ema_http_${res.status}`);

  const buffer = await res.arrayBuffer();
  const entries = await unzipText(buffer, ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml']);
  const sheet = entries['xl/worksheets/sheet1.xml'];
  if (!sheet) throw new Error('ema_sheet_missing');
  const shared = parseSharedStrings(entries['xl/sharedStrings.xml'] ?? '');

  const { rows } = scanSheet(sheet, shared);
  const headerCells = rows.get(HEADER_ROW);
  if (!headerCells) throw new Error('ema_header_missing');

  const columns: Record<string, string> = {};
  for (const [col, text] of Object.entries(headerCells)) {
    const header = text.replace(/\s+/g, ' ').trim();
    columns[col] = FIELDS[header] ?? slugField(header);
  }

  const medicines: Medicine[] = [];
  for (const [rowNum, cells] of rows) {
    if (rowNum <= HEADER_ROW) continue;
    const rec: Medicine = {};
    for (const [col, value] of Object.entries(cells)) {
      const field = columns[col];
      if (!field) continue;
      rec[field] = DATE_FIELDS.has(field) ? toIso(value) : value;
    }
    if (rec.name) medicines.push(rec);
  }
  if (!medicines.length) throw new Error('ema_no_records');

  return {
    medicines,
    fetchedAt: Date.now(),
    lastModified: res.headers.get('last-modified'),
  };
}

/**
 * One download per six hours, shared by every tool call in the isolate.
 * Concurrent callers await the same in-flight load rather than each starting
 * their own — that is what keeps a burst of tool calls off EMA's rate limiter.
 * If a refresh fails while a previous copy is in hand, the previous copy is
 * served instead of an error.
 */
async function dataset(): Promise<Dataset> {
  const now = Date.now();
  if (CACHE && now - CACHE.fetchedAt < DATASET_TTL_MS) return CACHE;
  if (INFLIGHT) return INFLIGHT;
  INFLIGHT = load()
    .then((d) => {
      CACHE = d;
      INFLIGHT = null;
      return d;
    })
    .catch((e) => {
      INFLIGHT = null;
      if (CACHE) return CACHE;
      throw e;
    });
  return INFLIGHT;
}

function unavailable(e: unknown) {
  const message = (e as Error)?.message ?? String(e);
  return {
    found: false,
    reason: message.startsWith('ema_') ? message.split(':')[0] : 'ema_dataset_unavailable',
    detail: message,
    hint:
      'The EMA medicines report download at ema.europa.eu did not answer. EMA rate-limits bursts, so retry once after a pause. For US approvals instead, use the openfda pack (drug labels and approvals); for the EU clinical-trial side, use clinicaltrials or euctr tools.',
    source: SOURCE,
  };
}

function provenance(d: Dataset) {
  return {
    source: SOURCE,
    source_url: XLSX_URL,
    source_last_modified: d.lastModified,
    total_records: d.medicines.length,
  };
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  return String(v).trim();
}

function limitOf(args: Record<string, unknown>, fallback: number, max = 200): number {
  const n = Number(args.limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** 'human' | 'veterinary' | undefined — accepts the sheet's own casing too. */
function categoryOf(args: Record<string, unknown>): string | undefined {
  const c = str(args, 'category')?.toLowerCase();
  if (!c || c === 'all' || c === 'any') return undefined;
  if (c.startsWith('h')) return 'Human';
  if (c.startsWith('v')) return 'Veterinary';
  return undefined;
}

/**
 * Accepts YYYY-MM-DD, YYYY-MM (start/end of month depending on `end`), YYYY,
 * or DD/MM/YYYY, and returns an ISO date string.
 */
function boundary(raw: string | undefined, end: boolean): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return end ? `${s}-31` : `${s}-01`;
  m = /^(\d{4})$/.exec(s);
  if (m) return end ? `${s}-12-31` : `${s}-01-01`;
  return undefined;
}

function inWindow(value: string | undefined, from?: string, to?: string): boolean {
  if (!value) return false;
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

const SUMMARY_FIELDS = [
  'name',
  'category',
  'medicine_status',
  'opinion_status',
  'inn',
  'active_substance',
  'therapeutic_area',
  'therapeutic_indication',
  'atc_code',
  'holder',
  'orphan_medicine',
  'conditional_approval',
  'accelerated_assessment',
  'prime_priority_medicine',
  'biosimilar',
  'generic',
  'marketing_authorisation_date',
  'ec_decision_date',
  'opinion_adopted_date',
  'ema_product_number',
  'url',
];

function summarize(m: Medicine, extra: string[] = []): Medicine {
  const out: Medicine = {};
  for (const f of [...SUMMARY_FIELDS, ...extra]) {
    if (m[f] !== undefined) out[f] = m[f];
  }
  return out;
}

function matches(m: Medicine, terms: string[], fields: string[]): boolean {
  const hay = fields
    .map((f) => m[f] ?? '')
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

const SEARCH_FIELDS = [
  'name',
  'inn',
  'active_substance',
  'therapeutic_area',
  'therapeutic_indication',
  'atc_code',
  'atcvet_code',
  'pharmacotherapeutic_group',
  'pharmacotherapeutic_group_vet',
  'holder',
  'ema_product_number',
  'species',
];

const tools: McpToolExport['tools'] = [
  {
    name: 'ema_recent_approvals',
    description:
      'New medicines authorised for the European Union market by the European Medicines Agency, in a date window. Returns brand name, active substance / INN, therapeutic area and indication, marketing-authorisation holder, authorisation date and EPAR link. Answers "which drugs did the EMA approve in July 2026", "recent EU drug approvals", "new EU marketing authorisations this year". Filtered on the marketing-authorisation date, which is the date an initial authorisation was granted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Earliest authorisation date. YYYY-MM-DD, YYYY-MM or YYYY.' },
        to: { type: 'string', description: 'Latest authorisation date. YYYY-MM-DD, YYYY-MM or YYYY.' },
        month: { type: 'string', description: 'Convenience for a single month, YYYY-MM (e.g. 2026-07). Overrides from/to.' },
        category: { type: 'string', description: 'human | veterinary. Omit for both.' },
        limit: { type: 'number', description: 'Max records, default 50, max 200.' },
      },
    },
  },
  {
    name: 'ema_chmp_opinions',
    description:
      'Medicines the EMA committees (CHMP for human medicines, CVMP for veterinary) have recommended for or against EU approval, still awaiting the European Commission decision. Returns brand name, active substance, applicant, opinion status and the date the opinion was adopted. Answers "which new medicines did the CHMP recommend for approval", "what is in the EMA pipeline awaiting a Commission decision", "recent negative CHMP opinions".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        opinion_status: { type: 'string', description: 'positive | negative | any. Default positive.' },
        since: { type: 'string', description: 'Earliest opinion-adopted date. YYYY-MM-DD, YYYY-MM or YYYY.' },
        category: { type: 'string', description: 'human | veterinary. Omit for both.' },
        include_decided: { type: 'boolean', description: 'Also return opinions on medicines the European Commission has already decided. Default false, which returns only opinions still awaiting a decision.' },
        limit: { type: 'number', description: 'Max records, default 50, max 200.' },
      },
    },
  },
  {
    name: 'ema_medicine_search',
    description:
      'Search the European Medicines Agency register of centrally authorised medicines by brand name, active substance or INN, therapeutic area, indication text, ATC code, or marketing-authorisation holder. Returns matching medicines with status, indication, holder, authorisation dates and EPAR link. Answers "is drug X authorised in the EU", "which EU medicines contain semaglutide", "what has AstraZeneca had authorised by the EMA", "EU authorised orphan medicines for cystic fibrosis".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text: brand name, substance, company, indication or ATC code.' },
        status: { type: 'string', description: 'Filter on medicine status, e.g. Authorised, Withdrawn, Refused, Opinion.' },
        category: { type: 'string', description: 'human | veterinary. Omit for both.' },
        orphan_only: { type: 'boolean', description: 'Only medicines designated orphan.' },
        limit: { type: 'number', description: 'Max records, default 25, max 200.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ema_medicine',
    description:
      'Full European Medicines Agency record for one medicine, looked up by brand name or EMA product number (EMEA/H/C/...). Returns every published field: status, authorised indication, active substance, ATC code, holder, orphan / conditional / accelerated / PRIME flags, and the full date history from evaluation start through authorisation, suspension or withdrawal. Answers "what is the EU authorised indication for X", "when was X approved in Europe", "who holds the EU marketing authorisation for X".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Brand name, INN, or EMA product number.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'ema_recent_updates',
    description:
      'Medicines whose European Medicines Agency register entry changed most recently — new authorisations, status changes to withdrawn or suspended, refreshed product information. Returns the medicine, what its status is now, and when the entry was last updated. Answers "what changed at the EMA this week", "which EU medicines were recently withdrawn or suspended".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'Earliest last-updated date. YYYY-MM-DD, YYYY-MM or YYYY.' },
        status: { type: 'string', description: 'Filter on medicine status, e.g. Withdrawn, Suspended, Authorised.' },
        category: { type: 'string', description: 'human | veterinary. Omit for both.' },
        limit: { type: 'number', description: 'Max records, default 25, max 200.' },
      },
    },
  },
  {
    name: 'herb_search',
    description:
      'Search the European Medicines Agency (EMA) herbal medicines inventory — the plant/botanical substances the EMA Committee on Herbal Medicinal Products (HMPC) has assessed or is assessing for use in herbal medicinal products across the EU. Search by common herb name, Latin/botanical name, therapeutic area, or assessment status. Returns each herb\'s status (e.g. assessment finalised, ongoing) and whether an EU herbal monograph or list entry exists. Answers "which herbs has the EMA assessed for anxiety", "is there an EU herbal monograph for chamomile", "EMA herbal inventory status for ginkgo".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Free text: common name, Latin name, or botanical name (e.g. "valerian", "chamomile", "Valeriana officinalis").' },
        latin: { type: 'string', description: 'Latin name filter (e.g. "Valerianae radix").' },
        botanical: { type: 'string', description: 'Botanical (scientific) species name filter (e.g. "Valeriana officinalis").' },
        therapeutic_area: { type: 'string', description: 'Therapeutic area filter, e.g. "anxiety", "sleep disorders", "gastrointestinal".' },
        status: { type: 'string', description: 'Assessment-status filter: a code (F, P, C, D, R) or text fragment, e.g. "finalised".' },
        limit: { type: 'number', description: 'Max records, default 25, max 100.' },
      },
    },
  },
  {
    name: 'herb',
    description:
      'Full European Medicines Agency (EMA) herbal-inventory record for one plant/herb, looked up by Latin name or English common name, plus the direct links to its EU herbal monograph PDF and assessment-report PDF scraped from the herb\'s EMA page. Returns botanical name(s), therapeutic areas, assessment status, outcome, and dates. Answers "what is the EMA monograph link for valerian root", "get the EU assessment report for ginkgo leaf", "EMA record for Hamamelis virginiana".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latin_name: { type: 'string', description: 'Latin name, e.g. "Valerianae radix".' },
        common_name: { type: 'string', description: 'English common name, e.g. "Valerian Root". Use if latin_name is not known.' },
      },
    },
  },
  {
    name: 'herb_monograph_status',
    description:
      'The European Medicines Agency (EMA) herbal-monograph assessment status for one herb by Latin name — the HMPC assessment status code and label (e.g. finalised, ongoing call for scientific data), the outcome of the European assessment (EU herbal monograph and/or EU list entry), and a note on well-established-use vs traditional-use classification. Answers "is the EMA valerian monograph well-established use or traditional use", "what is the assessment status of the EU chamomile monograph".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latin: { type: 'string', description: 'Latin name, e.g. "Valerianae radix".' },
      },
      required: ['latin'],
    },
  },
  {
    name: 'ema_shortages',
    description:
      'European Medicines Agency register of reported and ongoing medicine shortages in the EU. Returns the medicine, INN/active substance, shortage status (ongoing/resolved/discontinued), pharmaceutical forms and strengths affected, whether alternatives are available, start-of-shortage date and expected resolution. The EU counterpart of the FDA drug shortages database. Answers "which EU medicines are currently in shortage", "is there a shortage of X in Europe", "when will the semaglutide shortage resolve in the EU".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text: medicine name, INN/active substance, or therapeutic area.' },
        status: { type: 'string', description: 'Filter on shortage status, e.g. "ongoing", "resolved", "discontinued". Substring match.' },
        since: { type: 'string', description: 'Earliest start-of-shortage date. YYYY-MM-DD, YYYY-MM or YYYY.' },
        limit: { type: 'number', description: 'Max records, default 50, max 200.' },
      },
    },
  },
  {
    name: 'ema_dhpc',
    description:
      'Direct Healthcare Professional Communications (DHPCs) — urgent EU-wide safety communications the European Medicines Agency and national authorities send to doctors and pharmacists about a medicine, e.g. a new contraindication, adverse-event signal, quality defect or shortage. Returns the medicine, active substance(s), DHPC type, regulatory outcome, dissemination date and the DHPC document URL. Answers "what safety communications has the EMA issued about X", "recent EU direct healthcare professional communications", "has there been a DHPC for semaglutide".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text: medicine name, active substance, or referral name.' },
        dhpc_type: { type: 'string', description: 'Filter on DHPC type, e.g. "adverse event", "quality defect", "medicine shortage", "safety signal". Substring match.' },
        since: { type: 'string', description: 'Earliest dissemination date. YYYY-MM-DD, YYYY-MM or YYYY.' },
        category: { type: 'string', description: 'human | veterinary. Omit for both.' },
        limit: { type: 'number', description: 'Max records, default 50, max 200.' },
      },
    },
  },
  {
    name: 'ema_referrals',
    description:
      'European Medicines Agency referral procedures — EU-wide reviews of a medicine or class of medicines triggered by a safety concern, quality issue or scientific disagreement between member states (Article 31, Article 20, Article 107i and related procedures). Returns the referral name, INN, current status, whether it is a safety referral, procedure type, key milestone dates (procedure start, PRAC recommendation, CHMP/CVMP opinion, European Commission decision) and the referral URL. Answers "what EU safety referrals are open for X", "why was drug X reviewed by the EMA", "recent Article 31 referrals", "EU referral outcome for valproate".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text: referral name, INN/active substance, or associated medicine name.' },
        status: { type: 'string', description: 'Filter on current status, e.g. "under evaluation", "procedure started", "European Commission final decision". Substring match.' },
        safety_only: { type: 'boolean', description: 'Only referrals flagged as safety referrals. Default false (all referral types).' },
        category: { type: 'string', description: 'human | veterinary. Omit for both.' },
        since: { type: 'string', description: 'Earliest procedure-start date. YYYY-MM-DD, YYYY-MM or YYYY.' },
        limit: { type: 'number', description: 'Max records, default 50, max 200.' },
      },
    },
  },
  {
    name: 'ema_psusa',
    description:
      'European Medicines Agency Periodic Safety Update Report Single Assessments (PSUSA) — the EU-wide pharmacovigilance procedure where all products containing a given active substance are jointly reassessed for safety on a fixed schedule. Returns the active substance, related medicine names, procedure number, regulatory outcome (e.g. "Maintenance", "Variation", "Suspension") and dates. The closest structured EU signal to a pharmacovigilance safety review. Answers "when was the last PSUSA outcome for X", "has ibuprofen had a periodic safety update review", "recent EU pharmacovigilance outcomes".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text: active substance or related medicine name.' },
        outcome: { type: 'string', description: 'Filter on regulatory outcome, e.g. "Maintenance", "Variation", "Suspension", "Withdrawal". Substring match.' },
        since: { type: 'string', description: 'Earliest first-published date. YYYY-MM-DD, YYYY-MM or YYYY.' },
        limit: { type: 'number', description: 'Max records, default 50, max 200.' },
      },
    },
  },
  {
    name: 'ema_orphan_designations',
    description:
      'European Medicines Agency orphan medicinal product designations — active substances designated by the EU as treatments for rare diseases, which carry incentives like protocol assistance and market exclusivity. Returns the active substance, medicine name (once assigned), intended therapeutic use, EU designation number, designation status (Positive, Withdrawn, Expired, Negative) and dates. Catalyst-relevant for biotech: a positive designation often precedes a clinical or regulatory catalyst by months to years. Answers "what orphan designations has the EMA granted for rare disease X", "is drug X an EU-designated orphan medicine", "recent EU orphan designations".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text: active substance, medicine name, or intended-use text.' },
        status: { type: 'string', description: 'Filter on designation status: Positive, Withdrawn, Expired, or Negative.' },
        since: { type: 'string', description: 'Earliest date of designation/refusal. YYYY-MM-DD, YYYY-MM or YYYY.' },
        limit: { type: 'number', description: 'Max records, default 50, max 200.' },
      },
    },
  },
  {
    name: 'ema_pip',
    description:
      'European Medicines Agency Paediatric Investigation Plans (PIPs) — the agreed or waived plan for studying a medicine in children, required for most new EU marketing-authorisation applications. Returns the active substance, invented name (if assigned), therapeutic area, condition/indication under study, decision type (agreement, modification, waiver, compliance check) and decision date. Answers "what paediatric studies has the EMA required for X", "is there an EU paediatric investigation plan for drug X", "recent EMA paediatric decision for asthma".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text: active substance, invented name, or condition/indication text.' },
        decision_type: { type: 'string', description: 'Filter on decision type text, e.g. "waiver", "agreeing on", "compliance". Substring match.' },
        since: { type: 'string', description: 'Earliest decision date. YYYY-MM-DD, YYYY-MM or YYYY.' },
        limit: { type: 'number', description: 'Max records, default 50, max 200.' },
      },
    },
  },
  {
    name: 'ema_post_authorisation',
    description:
      'European Medicines Agency post-authorisation procedures — variations, label changes and other post-marketing procedure activity for centrally authorised medicines, distinct from the initial approval. Returns the medicine, active substance, procedure status, opinion status and date, and (for withdrawn applications) the withdrawal date. Answers "what post-authorisation variations has drug X had", "has the EMA changed the label for X recently", "which EU medicines had a post-authorisation opinion this month".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text: medicine name, active substance, or INN.' },
        status: { type: 'string', description: 'Filter on post-authorisation procedure status, e.g. "Opinion", "Application withdrawn". Substring match.' },
        category: { type: 'string', description: 'human | veterinary. Omit for both.' },
        since: { type: 'string', description: 'Earliest post-authorisation opinion date. YYYY-MM-DD, YYYY-MM or YYYY.' },
        limit: { type: 'number', description: 'Max records, default 50, max 200.' },
      },
    },
  },
];

function byDateDesc(field: string) {
  return (a: Medicine, b: Medicine) => (b[field] ?? '').localeCompare(a[field] ?? '');
}

// ---------------------------------------------------------------------------
// Sibling XLSX reports — shortages, DHPC, referrals, PSUSA, orphan
// designations, paediatric investigation plans, post-authorisation. Same
// download-medicine-data page, same daily-regenerated-XLSX pattern, same
// xlsx.ts reader and one-download-per-six-hours cache as the main register.
// Each report has its own column schema (probed live 2026-09-13), so this is
// a small generic loader parameterised by a ReportSpec rather than seven
// copies of load()/dataset().
//
// Trap: post_authorisation's header row puts the URL column at "AA", out of
// alphabetical order with the rest (A, AA, B, C, ...) — the column-letter
// keys from scanSheet() are just whatever the sheet XML uses, so this is not
// a bug, just a real quirk of EMA's own export worth not "fixing" by assuming
// A..Z order.
// ---------------------------------------------------------------------------

type ReportRow = Record<string, string>;

interface ReportSpec {
  key: string;
  url: string;
  source: string;
  fields: Record<string, string>;
  dateFields: Set<string>;
  /** Field whose presence marks a row as real data (mirrors `if (rec.name)` above). */
  requiredField: string;
}

interface ReportDataset {
  rows: ReportRow[];
  fetchedAt: number;
  lastModified: string | null;
}

const REPORT_HEADER_ROW = 9;
const REPORT_TTL_MS = 6 * 60 * 60 * 1000;

const REPORTS: Record<string, ReportSpec> = {
  shortages: {
    key: 'shortages',
    url: 'https://www.ema.europa.eu/en/documents/report/medicines-output-shortages-report_en.xlsx',
    source: 'European Medicines Agency — medicine shortages report (medicines-output-shortages-report_en.xlsx)',
    requiredField: 'medicine',
    fields: {
      'Category': 'category',
      'Medicine affected': 'medicine',
      'Supply shortage status': 'shortage_status',
      'International non-proprietary name (INN) or common name': 'inn',
      'Therapeutic area (MeSH)': 'therapeutic_area',
      'Pharmaceutical forms affected': 'pharmaceutical_forms',
      'Strengths affected': 'strengths',
      'Availability of alternatives': 'alternatives_available',
      'Start of shortage date': 'shortage_start_date',
      'Expected resolution date': 'expected_resolution_date',
      'Expected resolution': 'expected_resolution',
      'First published date': 'first_published_date',
      'Last updated date': 'last_updated_date',
      'Shortage URL': 'url',
    },
    dateFields: new Set(['shortage_start_date', 'expected_resolution_date', 'first_published_date', 'last_updated_date']),
  },
  dhpc: {
    key: 'dhpc',
    url: 'https://www.ema.europa.eu/en/documents/report/medicines-output-dhpc-report_en.xlsx',
    source: 'European Medicines Agency — direct healthcare professional communications report (medicines-output-dhpc-report_en.xlsx)',
    requiredField: 'name',
    fields: {
      'Category': 'category',
      'Name of medicine': 'name',
      'Procedure number': 'procedure_number',
      'Active substances': 'active_substances',
      'DHPC type': 'dhpc_type',
      'Regulatory outcome': 'regulatory_outcome',
      'Referral name': 'referral_name',
      'ATC code (human)': 'atc_code',
      'ATCvet code (veterinary)': 'atcvet_code',
      'Therapeutic area (MeSH)': 'therapeutic_area',
      'Species': 'species',
      'Other related medicines\n(nationally authorised)': 'other_related_medicines',
      'Dissemination date': 'dissemination_date',
      'First published date': 'first_published_date',
      'Last updated date': 'last_updated_date',
      'DHPC URL': 'url',
    },
    dateFields: new Set(['dissemination_date', 'first_published_date', 'last_updated_date']),
  },
  referrals: {
    key: 'referrals',
    url: 'https://www.ema.europa.eu/en/documents/report/medicines-output-referrals-report_en.xlsx',
    source: 'European Medicines Agency — referrals report (medicines-output-referrals-report_en.xlsx)',
    requiredField: 'referral_name',
    fields: {
      'Category': 'category',
      'Referral name': 'referral_name',
      'International non-proprietary name (INN) / common name': 'inn',
      'Current status': 'status',
      'Safety referral?': 'safety_referral',
      'Referral type': 'referral_type',
      'Associated names (centrally authorised medicines)': 'associated_centrally_authorised',
      'Associated names (non-centrally authorised medicines)': 'associated_non_centrally_authorised',
      'Class': 'class',
      'Reference number': 'reference_number',
      'Non-PRAC decision making model': 'non_prac_decision_model',
      'PRAC decision making model': 'prac_decision_model',
      'Authorisation model': 'authorisation_model',
      'PRAC recommendation': 'prac_recommendation',
      'Procedure start date': 'procedure_start_date',
      'PRAC recommendation date': 'prac_recommendation_date',
      'CMDh position date': 'cmdh_position_date',
      'CHMP/CVMP opinion date': 'opinion_date',
      'European Commission decision date': 'ec_decision_date',
      'First published date': 'first_published_date',
      'Last updated date': 'last_updated_date',
      'Referral URL': 'url',
    },
    dateFields: new Set([
      'procedure_start_date',
      'prac_recommendation_date',
      'cmdh_position_date',
      'opinion_date',
      'ec_decision_date',
      'first_published_date',
      'last_updated_date',
    ]),
  },
  psusa: {
    key: 'psusa',
    url: 'https://www.ema.europa.eu/en/documents/report/medicines-output-periodic_safety_update_report_single_assessments-report_en.xlsx',
    source:
      'European Medicines Agency — periodic safety update report single assessments (medicines-output-periodic_safety_update_report_single_assessments-report_en.xlsx)',
    requiredField: 'procedure_number',
    fields: {
      'Category': 'category',
      'Active substances in scope of procedure': 'substances_in_scope',
      'Active substance': 'active_substance',
      'Related medicines': 'related_medicines',
      'Procedure number': 'procedure_number',
      'Regulatory outcome': 'regulatory_outcome',
      'First published date': 'first_published_date',
      'Last updated date': 'last_updated_date',
      'PSUSA URL': 'url',
    },
    dateFields: new Set(['first_published_date', 'last_updated_date']),
  },
  orphan_designations: {
    key: 'orphan_designations',
    url: 'https://www.ema.europa.eu/en/documents/report/medicines-output-orphan_designations-report_en.xlsx',
    source: 'European Medicines Agency — orphan designations report (medicines-output-orphan_designations-report_en.xlsx)',
    requiredField: 'active_substance',
    fields: {
      'Medicine name': 'name',
      'Related EMA product number': 'ema_product_number',
      'Active substance': 'active_substance',
      'Date of designation / refusal': 'designation_date',
      'Intended use': 'intended_use',
      'EU designation number': 'eu_designation_number',
      'Status': 'status',
      'First published date': 'first_published_date',
      'Last updated date': 'last_updated_date',
      'Orphan designation URL': 'url',
    },
    dateFields: new Set(['designation_date', 'first_published_date', 'last_updated_date']),
  },
  paediatric_investigation_plans: {
    key: 'paediatric_investigation_plans',
    url: 'https://www.ema.europa.eu/en/documents/report/medicines-output-paediatric_investigation_plans-report_en.xlsx',
    source:
      'European Medicines Agency — paediatric investigation plans report (medicines-output-paediatric_investigation_plans-report_en.xlsx)',
    requiredField: 'active_substance',
    fields: {
      'Decision number': 'decision_number',
      'PIP number': 'pip_number',
      'Active substance': 'active_substance',
      'Invented name': 'name',
      'Therapeutic area': 'therapeutic_area',
      'Pharmaceutical forms': 'pharmaceutical_forms',
      'Condition / indication': 'indication',
      'Routes of administration': 'routes_of_administration',
      'Decision type': 'decision_type',
      'Decision date': 'decision_date',
      'Compliance outcome': 'compliance_outcome',
      'Compliance opinion date': 'compliance_opinion_date',
      'Compliance procedure number': 'compliance_procedure_number',
      'Contact for public enquiries': 'contact',
      'First published date': 'first_published_date',
      'Last updated date': 'last_updated_date',
      'PIP URL': 'url',
    },
    dateFields: new Set(['decision_date', 'compliance_opinion_date', 'first_published_date', 'last_updated_date']),
  },
  post_authorisation: {
    key: 'post_authorisation',
    url: 'https://www.ema.europa.eu/en/documents/report/medicines-output-post_authorisation-report_en.xlsx',
    source: 'European Medicines Agency — post-authorisation procedures report (medicines-output-post_authorisation-report_en.xlsx)',
    requiredField: 'name',
    fields: {
      'Category': 'category',
      'Medicine post-authorisation procedure URL': 'url',
      'Name of medicine': 'name',
      'EMA product number': 'ema_product_number',
      'Active substance': 'active_substance',
      'International non-proprietary name (INN) / common name': 'inn',
      'Therapeutic area (MeSH)': 'therapeutic_area',
      'ATC code (human)': 'atc_code',
      'ATCvet code (veterinary)': 'atcvet_code',
      'Species\n(veterinary)': 'species',
      'Accelerated assessment': 'accelerated_assessment',
      'Additional monitoring': 'additional_monitoring',
      'Advanced therapy': 'advanced_therapy',
      'Biosimilar': 'biosimilar',
      'Conditional approval': 'conditional_approval',
      'Exceptional circumstances': 'exceptional_circumstances',
      'Generic': 'generic',
      'Orphan medicine': 'orphan_medicine',
      'PRIME: priority medicine': 'prime_priority_medicine',
      'Marketing authorisation developer / applicant / holder': 'holder',
      'Post-authorisation procedure status': 'procedure_status',
      'Post-authorisation opinion status': 'opinion_status',
      'Post-authorisation opinion date': 'opinion_date',
      'Withdrawal of application date': 'application_withdrawal_date',
      'Marketing authorisation date': 'marketing_authorisation_date',
      'First published date': 'first_published_date',
      'Last updated date': 'last_updated_date',
    },
    dateFields: new Set([
      'opinion_date',
      'application_withdrawal_date',
      'marketing_authorisation_date',
      'first_published_date',
      'last_updated_date',
    ]),
  },
};

const REPORT_CACHE = new Map<string, ReportDataset | null>();
const REPORT_INFLIGHT = new Map<string, Promise<ReportDataset>>();

async function loadReport(spec: ReportSpec): Promise<ReportDataset> {
  let res: Response;
  try {
    res = await pwFetch(spec.url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      cf: {
        cacheTtlByStatus: { '200-299': 21600, '400-499': 60, '500-599': 10 },
        cacheEverything: true,
      },
    } as RequestInit);
  } catch (e) {
    throw new Error(`ema_${spec.key}_fetch_failed:${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`ema_${spec.key}_http_${res.status}`);

  const buffer = await res.arrayBuffer();
  const entries = await unzipText(buffer, ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml']);
  const sheet = entries['xl/worksheets/sheet1.xml'];
  if (!sheet) throw new Error(`ema_${spec.key}_sheet_missing`);
  const shared = parseSharedStrings(entries['xl/sharedStrings.xml'] ?? '');

  const { rows: sheetRows } = scanSheet(sheet, shared);
  const headerCells = sheetRows.get(REPORT_HEADER_ROW);
  if (!headerCells) throw new Error(`ema_${spec.key}_header_missing`);

  const columns: Record<string, string> = {};
  for (const [col, text] of Object.entries(headerCells)) {
    const header = text.replace(/\s+/g, ' ').trim();
    columns[col] = spec.fields[header] ?? slugField(header);
  }

  const rows: ReportRow[] = [];
  for (const [rowNum, cells] of sheetRows) {
    if (rowNum <= REPORT_HEADER_ROW) continue;
    const rec: ReportRow = {};
    for (const [col, value] of Object.entries(cells)) {
      const field = columns[col];
      if (!field) continue;
      rec[field] = spec.dateFields.has(field) ? toIso(value) : value;
    }
    if (rec[spec.requiredField]) rows.push(rec);
  }
  if (!rows.length) throw new Error(`ema_${spec.key}_no_records`);

  return { rows, fetchedAt: Date.now(), lastModified: res.headers.get('last-modified') };
}

async function reportDataset(spec: ReportSpec): Promise<ReportDataset> {
  const now = Date.now();
  const cached = REPORT_CACHE.get(spec.key);
  if (cached && now - cached.fetchedAt < REPORT_TTL_MS) return cached;
  const inflight = REPORT_INFLIGHT.get(spec.key);
  if (inflight) return inflight;
  const p = loadReport(spec)
    .then((d) => {
      REPORT_CACHE.set(spec.key, d);
      REPORT_INFLIGHT.delete(spec.key);
      return d;
    })
    .catch((e) => {
      REPORT_INFLIGHT.delete(spec.key);
      const prior = REPORT_CACHE.get(spec.key);
      if (prior) return prior;
      throw e;
    });
  REPORT_INFLIGHT.set(spec.key, p);
  return p;
}

function reportUnavailable(spec: ReportSpec, e: unknown) {
  const message = (e as Error)?.message ?? String(e);
  return {
    found: false,
    reason: message.startsWith('ema_') ? message.split(':')[0] : `ema_${spec.key}_dataset_unavailable`,
    detail: message,
    hint: `The EMA ${spec.key.replace(/_/g, ' ')} report download at ema.europa.eu did not answer. EMA rate-limits bursts, so retry once after a pause.`,
    source: spec.source,
  };
}

function reportProvenance(spec: ReportSpec, d: ReportDataset) {
  return {
    source: spec.source,
    source_url: spec.url,
    source_last_modified: d.lastModified,
    total_records: d.rows.length,
  };
}

function reportCategoryOf(args: Record<string, unknown>): string | undefined {
  return categoryOf(args);
}

async function callReportTool(name: string, spec: ReportSpec, args: Record<string, unknown>, opts: {
  searchFields: string[];
  dateField?: string;
  extraFilter?: (r: ReportRow, args: Record<string, unknown>) => boolean;
  sortField?: string;
  categoryFilter?: boolean;
  noMatchHint: string;
}): Promise<unknown> {
  let d: ReportDataset;
  try {
    d = await reportDataset(spec);
  } catch (e) {
    return reportUnavailable(spec, e);
  }

  let pool = d.rows;
  if (opts.categoryFilter) {
    const category = reportCategoryOf(args);
    if (category) pool = pool.filter((r) => r.category === category);
  }

  const query = str(args, 'query');
  if (query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    pool = pool.filter((r) => matches(r, terms, opts.searchFields));
  }

  if (opts.dateField) {
    const since = boundary(str(args, 'since'), false);
    if (since) pool = pool.filter((r) => inWindow(r[opts.dateField as string], since, undefined));
  }

  if (opts.extraFilter) pool = pool.filter((r) => opts.extraFilter!(r, args));

  const limit = limitOf(args, 50);
  const sorted = opts.sortField ? [...pool].sort(byDateDesc(opts.sortField)) : pool;

  if (!sorted.length) {
    return {
      found: false,
      reason: 'no_match',
      query: query ?? null,
      hint: opts.noMatchHint,
      ...reportProvenance(spec, d),
    };
  }
  return {
    found: true,
    query: query ?? null,
    count: sorted.length,
    records: sorted.slice(0, limit),
    ...reportProvenance(spec, d),
  };
}

// ---------------------------------------------------------------------------
// Herbal medicines — same file family, a separate daily XLSX, read with the
// same xlsx.ts reader and the same one-download-per-six-hours cache pattern.
// Source: https://www.ema.europa.eu/en/documents/report/medicines-output-herbal_medicines-report_en.xlsx
// Sheet layout matches the main register: row 1 banner, ROW 9 IS THE HEADER,
// rows 10+ records. 251 data rows collapse to 204 DISTINCT herbs (verified
// 2026-09-07) — the sheet repeats a handful of herbs' rows identically 2-4x
// (Fragariae folium ×4, etc.), so dedup on the per-herb page URL.
// ---------------------------------------------------------------------------

const HERBAL_XLSX_URL =
  'https://www.ema.europa.eu/en/documents/report/medicines-output-herbal_medicines-report_en.xlsx';
const HERBAL_SOURCE =
  'European Medicines Agency — herbal medicines register (medicines-output-herbal_medicines-report_en.xlsx)';
const HERBAL_HEADER_ROW = 9;
const HERBAL_DATASET_TTL_MS = 6 * 60 * 60 * 1000;
// The per-herb page is far less volatile than the register row (it only
// changes when a new monograph document is published), so a longer cache is
// safe and keeps repeat lookups off ema.europa.eu.
const HERB_PAGE_TTL_MS = 24 * 60 * 60 * 1000;

const HERBAL_FIELDS: Record<string, string> = {
  'Latin name': 'latin_name',
  'Combination': 'combination',
  'English common name': 'common_name',
  'Botanical name': 'botanical_name',
  'Therapeutic area': 'therapeutic_area',
  'Status': 'status',
  'Outcome of European assessment': 'outcome',
  'Additional information': 'additional_information',
  'Date added to the inventory': 'date_added_to_inventory',
  'Date added to the priority list': 'date_added_to_priority_list',
  'First published date': 'first_published_date',
  'Last updated date': 'last_updated_date',
  'Herbal medicine URL': 'page_url',
};

const HERBAL_DATE_FIELDS = new Set([
  'date_added_to_inventory',
  'date_added_to_priority_list',
  'first_published_date',
  'last_updated_date',
]);

export type Herb = Record<string, string>;

interface HerbalDataset {
  herbs: Herb[];
  fetchedAt: number;
  lastModified: string | null;
}

let HERBAL_CACHE: HerbalDataset | null = null;
let HERBAL_INFLIGHT: Promise<HerbalDataset> | null = null;

async function loadHerbal(): Promise<HerbalDataset> {
  let res: Response;
  try {
    res = await pwFetch(HERBAL_XLSX_URL, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      cf: {
        cacheTtlByStatus: { '200-299': 21600, '400-499': 60, '500-599': 10 },
        cacheEverything: true,
      },
    } as RequestInit);
  } catch (e) {
    throw new Error(`ema_herbal_fetch_failed:${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`ema_herbal_http_${res.status}`);

  const buffer = await res.arrayBuffer();
  const entries = await unzipText(buffer, ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml']);
  const sheet = entries['xl/worksheets/sheet1.xml'];
  if (!sheet) throw new Error('ema_herbal_sheet_missing');
  const shared = parseSharedStrings(entries['xl/sharedStrings.xml'] ?? '');

  const { rows } = scanSheet(sheet, shared);
  const headerCells = rows.get(HERBAL_HEADER_ROW);
  if (!headerCells) throw new Error('ema_herbal_header_missing');

  const columns: Record<string, string> = {};
  for (const [col, text] of Object.entries(headerCells)) {
    const header = text.replace(/\s+/g, ' ').trim();
    columns[col] = HERBAL_FIELDS[header] ?? slugField(header);
  }

  const seenUrls = new Set<string>();
  const herbs: Herb[] = [];
  for (const [rowNum, cells] of rows) {
    if (rowNum <= HERBAL_HEADER_ROW) continue;
    const rec: Herb = {};
    for (const [col, value] of Object.entries(cells)) {
      const field = columns[col];
      if (!field) continue;
      rec[field] = HERBAL_DATE_FIELDS.has(field) ? toIso(value) : value;
    }
    if (!rec.latin_name) continue;
    // Dedup the sheet's repeated identical rows — keyed on the per-herb page
    // URL, which is one-to-one with a distinct herb/combination.
    const key = rec.page_url || rec.latin_name;
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    herbs.push(rec);
  }
  if (!herbs.length) throw new Error('ema_herbal_no_records');

  return {
    herbs,
    fetchedAt: Date.now(),
    lastModified: res.headers.get('last-modified'),
  };
}

async function herbalDataset(): Promise<HerbalDataset> {
  const now = Date.now();
  if (HERBAL_CACHE && now - HERBAL_CACHE.fetchedAt < HERBAL_DATASET_TTL_MS) return HERBAL_CACHE;
  if (HERBAL_INFLIGHT) return HERBAL_INFLIGHT;
  HERBAL_INFLIGHT = loadHerbal()
    .then((d) => {
      HERBAL_CACHE = d;
      HERBAL_INFLIGHT = null;
      return d;
    })
    .catch((e) => {
      HERBAL_INFLIGHT = null;
      if (HERBAL_CACHE) return HERBAL_CACHE;
      throw e;
    });
  return HERBAL_INFLIGHT;
}

function herbalUnavailable(e: unknown) {
  const message = (e as Error)?.message ?? String(e);
  return {
    found: false,
    reason: message.startsWith('ema_') ? message.split(':')[0] : 'ema_herbal_dataset_unavailable',
    detail: message,
    hint:
      'The EMA herbal medicines report download at ema.europa.eu did not answer. EMA rate-limits bursts, so retry once after a pause.',
    source: HERBAL_SOURCE,
  };
}

function herbalProvenance(d: HerbalDataset) {
  return {
    source: HERBAL_SOURCE,
    source_url: HERBAL_XLSX_URL,
    source_last_modified: d.lastModified,
    total_herbs: d.herbs.length,
  };
}

/** "F: Assessment finalised" -> { status_code: "F", status_label: "Assessment finalised" }. */
function splitStatus(raw: string | undefined): { status_code: string | null; status_label: string | null } {
  if (!raw) return { status_code: null, status_label: null };
  const m = /^([A-Z]):\s*(.+)$/.exec(raw);
  return m ? { status_code: m[1], status_label: m[2] } : { status_code: null, status_label: raw };
}

function summarizeHerb(h: Herb): Record<string, unknown> {
  const { status_code, status_label } = splitStatus(h.status);
  return {
    latin_name: h.latin_name,
    combination: h.combination,
    common_name: h.common_name,
    botanical_name: h.botanical_name,
    therapeutic_area: h.therapeutic_area,
    status: h.status,
    status_code,
    status_label,
    outcome: h.outcome ?? null,
    additional_information: h.additional_information ?? null,
    date_added_to_inventory: h.date_added_to_inventory ?? null,
    last_updated_date: h.last_updated_date ?? null,
    page_url: h.page_url,
  };
}

const HERB_SEARCH_FIELDS = ['latin_name', 'common_name', 'botanical_name', 'therapeutic_area', 'combination'];

/**
 * Pull the monograph and assessment-report PDF links off a herb's EMA page.
 * LINK EXTRACTION ONLY — this never reads the page's prose (the FAQ-style
 * "well-established use" / "traditional use" explainer text lives there, but
 * scraping it is out of scope; see herb_monograph_status for why the register
 * itself does not carry that distinction as a field).
 *
 * A herb page lists every revision's documents as plain relative hrefs under
 * `/en/documents/<category>/<filename>_en.pdf`. Category tells you the
 * document type (`herbal-monograph` = the monograph itself, `herbal-report` =
 * the assessment report); the filename prefix tells you its status
 * (`final-` > `draft-` > `superseded-...`). Pick the best-ranked link per
 * category rather than the first one in document order.
 */
const PDF_HREF_RE = /href="(\/en\/documents\/([a-z-]+)\/([^"]+\.pdf))"/gi;

function rankDocument(filename: string): number {
  const f = filename.toLowerCase();
  if (f.startsWith('superseded')) return 2;
  if (f.startsWith('final')) return 0;
  return 1; // draft, or any other still-current prefix
}

function documentType(filename: string): string {
  const f = filename.toLowerCase();
  if (f.startsWith('superseded')) return 'superseded';
  if (f.startsWith('final')) return 'final';
  if (f.startsWith('draft')) return 'draft';
  return 'other';
}

interface HerbDocuments {
  monograph_url: string | null;
  monograph_document_type: string | null;
  assessment_report_url: string | null;
  assessment_report_document_type: string | null;
}

function extractHerbDocuments(html: string): HerbDocuments {
  const best: Record<string, { url: string; filename: string; rank: number }> = {};
  PDF_HREF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PDF_HREF_RE.exec(html)) !== null) {
    const [, href, category, filename] = m;
    // herbal-monograph = the monograph; herbal-report = the assessment report.
    // Everything else (herbal-opinion, herbal-list-entry, herbal-summary,
    // herbal-references, herbal-comments, herbal-call-data) is out of scope.
    if (category !== 'herbal-monograph' && category !== 'herbal-report') continue;
    const rank = rankDocument(filename);
    const existing = best[category];
    if (!existing || rank < existing.rank) {
      best[category] = { url: `https://www.ema.europa.eu${href}`, filename, rank };
    }
  }
  const mono = best['herbal-monograph'];
  const report = best['herbal-report'];
  return {
    monograph_url: mono?.url ?? null,
    monograph_document_type: mono ? documentType(mono.filename) : null,
    assessment_report_url: report?.url ?? null,
    assessment_report_document_type: report ? documentType(report.filename) : null,
  };
}

interface HerbPageEntry {
  documents: HerbDocuments;
  fetchedAt: number;
}

const HERB_PAGE_CACHE = new Map<string, HerbPageEntry>();

async function fetchHerbDocuments(pageUrl: string): Promise<HerbDocuments> {
  const cached = HERB_PAGE_CACHE.get(pageUrl);
  if (cached && Date.now() - cached.fetchedAt < HERB_PAGE_TTL_MS) return cached.documents;

  let res: Response;
  try {
    res = await pwFetch(pageUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      cf: {
        cacheTtlByStatus: { '200-299': 86400, '400-499': 60, '500-599': 10 },
        cacheEverything: true,
      },
    } as RequestInit);
  } catch (e) {
    throw new Error(`ema_herb_page_fetch_failed:${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`ema_herb_page_http_${res.status}`);
  const html = await res.text();
  const documents = extractHerbDocuments(html);
  HERB_PAGE_CACHE.set(pageUrl, { documents, fetchedAt: Date.now() });
  return documents;
}

const USE_CLASSIFICATION_NOTE =
  'The EMA herbal-inventory register (the "Outcome of European assessment" field) records only whether an EU herbal monograph and/or EU list entry exists — it does not itself label a herb well-established-use or traditional-use. That classification is set per-indication INSIDE the monograph document (Article 10a "well-established use" vs Article 16a "traditional use"), and a single herb can carry both for different indications (e.g. valerian root: well-established use for mild nervous tension and sleep, traditional use for mild mental stress) — see monograph_url for the full text.';

async function callHerbalTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  let d: HerbalDataset;
  try {
    d = await herbalDataset();
  } catch (e) {
    return herbalUnavailable(e);
  }

  switch (name) {
    case 'herb_search': {
      const nameQuery = str(args, 'name');
      const latin = str(args, 'latin')?.toLowerCase();
      const botanical = str(args, 'botanical')?.toLowerCase();
      const therapeuticArea = str(args, 'therapeutic_area')?.toLowerCase();
      const status = str(args, 'status')?.toLowerCase();
      const limit = limitOf(args, 25, 100);

      let hits = d.herbs;
      if (nameQuery) {
        const terms = nameQuery.toLowerCase().split(/\s+/).filter(Boolean);
        hits = hits.filter((h) => matches(h, terms, HERB_SEARCH_FIELDS));
      }
      if (latin) hits = hits.filter((h) => (h.latin_name ?? '').toLowerCase().includes(latin));
      if (botanical) hits = hits.filter((h) => (h.botanical_name ?? '').toLowerCase().includes(botanical));
      if (therapeuticArea) hits = hits.filter((h) => (h.therapeutic_area ?? '').toLowerCase().includes(therapeuticArea));
      if (status) {
        hits = hits.filter((h) => {
          const { status_code, status_label } = splitStatus(h.status);
          return (
            (status_code ?? '').toLowerCase() === status ||
            (status_label ?? '').toLowerCase().includes(status) ||
            (h.status ?? '').toLowerCase().includes(status)
          );
        });
      }

      if (!hits.length) {
        return {
          found: false,
          reason: 'no_match',
          hint:
            'No herb in the EMA herbal-medicines inventory matches those filters. Try a broader `name` (common or Latin name), drop `therapeutic_area`, or drop `status`.',
          ...herbalProvenance(d),
        };
      }
      return {
        found: true,
        count: hits.length,
        herbs: hits.slice(0, limit).map(summarizeHerb),
        ...herbalProvenance(d),
      };
    }

    case 'herb': {
      const latinArg = str(args, 'latin_name')?.toLowerCase();
      const commonArg = str(args, 'common_name')?.toLowerCase();
      if (!latinArg && !commonArg) {
        return { found: false, reason: 'missing_query', hint: 'Pass latin_name or common_name.' };
      }
      const exact =
        (latinArg && d.herbs.find((h) => (h.latin_name ?? '').toLowerCase() === latinArg)) ||
        (commonArg && d.herbs.find((h) => (h.common_name ?? '').toLowerCase() === commonArg)) ||
        undefined;
      const match =
        exact ||
        (latinArg && d.herbs.find((h) => (h.latin_name ?? '').toLowerCase().includes(latinArg))) ||
        (commonArg && d.herbs.find((h) => (h.common_name ?? '').toLowerCase().includes(commonArg))) ||
        undefined;

      if (!match) {
        const key = latinArg ?? commonArg ?? '';
        const candidates = d.herbs
          .filter((h) => (h.latin_name ?? '').toLowerCase().includes(key) || (h.common_name ?? '').toLowerCase().includes(key))
          .slice(0, 10)
          .map((h) => ({ latin_name: h.latin_name, common_name: h.common_name }));
        return {
          found: false,
          reason: 'no_match',
          query: latinArg ?? commonArg,
          candidates,
          hint: candidates.length
            ? 'No exact match. Retry `herb` with one of the candidate latin_name values, or call herb_search for a broader search.'
            : 'No herb with that name in the EMA herbal-medicines inventory. Call herb_search for a broader search.',
          ...herbalProvenance(d),
        };
      }

      let documents: HerbDocuments;
      try {
        documents = await fetchHerbDocuments(match.page_url);
      } catch (e) {
        return {
          found: true,
          herb: summarizeHerb(match),
          page_url: match.page_url,
          monograph_url: null,
          assessment_report_url: null,
          documents_error: (e as Error).message,
          hint: 'The herb record was found but its EMA page did not answer, so the monograph/assessment-report links could not be scraped. Retry, or open page_url directly.',
          ...herbalProvenance(d),
        };
      }
      return {
        found: true,
        herb: summarizeHerb(match),
        page_url: match.page_url,
        ...documents,
        ...herbalProvenance(d),
      };
    }

    case 'herb_monograph_status': {
      const latin = str(args, 'latin');
      if (!latin) return { found: false, reason: 'missing_latin', hint: 'Pass latin — the Latin name, e.g. "Valerianae radix".' };
      const key = latin.toLowerCase();
      const match =
        d.herbs.find((h) => (h.latin_name ?? '').toLowerCase() === key) ??
        d.herbs.find((h) => (h.latin_name ?? '').toLowerCase().includes(key));
      if (!match) {
        return {
          found: false,
          reason: 'no_match',
          query: latin,
          hint: 'No herb with that Latin name in the EMA herbal-medicines inventory. Call herb_search to find the correct Latin name.',
          ...herbalProvenance(d),
        };
      }
      const { status_code, status_label } = splitStatus(match.status);
      return {
        found: true,
        latin_name: match.latin_name,
        common_name: match.common_name ?? null,
        botanical_name: match.botanical_name ?? null,
        status: match.status ?? null,
        status_code,
        status_label,
        outcome: match.outcome ?? null,
        additional_information: match.additional_information ?? null,
        use_classification: null,
        use_classification_note: USE_CLASSIFICATION_NOTE,
        page_url: match.page_url,
        ...herbalProvenance(d),
      };
    }

    default:
      throw new Error(`Unknown herbal tool: ${name}`);
  }
}

const REPORT_TOOL_SPECS: Record<
  string,
  { spec: ReportSpec } & Parameters<typeof callReportTool>[3]
> = {
  ema_shortages: {
    spec: REPORTS.shortages,
    searchFields: ['medicine', 'inn', 'therapeutic_area'],
    dateField: 'shortage_start_date',
    sortField: 'shortage_start_date',
    extraFilter: (r, args) => {
      const status = str(args, 'status')?.toLowerCase();
      return !status || (r.shortage_status ?? '').toLowerCase().includes(status);
    },
    noMatchHint:
      'No medicine shortage matches those filters. Try a broader `query`, drop `status`, or widen `since`.',
  },
  ema_dhpc: {
    spec: REPORTS.dhpc,
    searchFields: ['name', 'active_substances', 'referral_name'],
    dateField: 'dissemination_date',
    sortField: 'dissemination_date',
    categoryFilter: true,
    extraFilter: (r, args) => {
      const dhpcType = str(args, 'dhpc_type')?.toLowerCase();
      return !dhpcType || (r.dhpc_type ?? '').toLowerCase().includes(dhpcType);
    },
    noMatchHint:
      'No direct healthcare professional communication matches those filters. Try a broader `query`, drop `dhpc_type`, or widen `since`.',
  },
  ema_referrals: {
    spec: REPORTS.referrals,
    searchFields: ['referral_name', 'inn', 'associated_centrally_authorised', 'associated_non_centrally_authorised'],
    dateField: 'procedure_start_date',
    sortField: 'procedure_start_date',
    categoryFilter: true,
    extraFilter: (r, args) => {
      const status = str(args, 'status')?.toLowerCase();
      const safetyOnly = args.safety_only === true || String(args.safety_only) === 'true';
      if (status && !(r.status ?? '').toLowerCase().includes(status)) return false;
      if (safetyOnly && (r.safety_referral ?? '').toLowerCase() !== 'yes') return false;
      return true;
    },
    noMatchHint:
      'No referral procedure matches those filters. Try a broader `query`, drop `status`, set `safety_only` false, or widen `since`.',
  },
  ema_psusa: {
    spec: REPORTS.psusa,
    searchFields: ['active_substance', 'substances_in_scope', 'related_medicines'],
    dateField: 'first_published_date',
    sortField: 'first_published_date',
    extraFilter: (r, args) => {
      const outcome = str(args, 'outcome')?.toLowerCase();
      return !outcome || (r.regulatory_outcome ?? '').toLowerCase().includes(outcome);
    },
    noMatchHint:
      'No periodic safety update single assessment matches those filters. Try a broader `query`, drop `outcome`, or widen `since`.',
  },
  ema_orphan_designations: {
    spec: REPORTS.orphan_designations,
    searchFields: ['active_substance', 'name', 'intended_use'],
    dateField: 'designation_date',
    sortField: 'designation_date',
    extraFilter: (r, args) => {
      const status = str(args, 'status')?.toLowerCase();
      return !status || (r.status ?? '').toLowerCase() === status;
    },
    noMatchHint:
      'No orphan designation matches those filters. Try a broader `query`, drop `status`, or widen `since`.',
  },
  ema_pip: {
    spec: REPORTS.paediatric_investigation_plans,
    searchFields: ['active_substance', 'name', 'indication'],
    dateField: 'decision_date',
    sortField: 'decision_date',
    extraFilter: (r, args) => {
      const decisionType = str(args, 'decision_type')?.toLowerCase();
      return !decisionType || (r.decision_type ?? '').toLowerCase().includes(decisionType);
    },
    noMatchHint:
      'No paediatric investigation plan matches those filters. Try a broader `query`, drop `decision_type`, or widen `since`.',
  },
  ema_post_authorisation: {
    spec: REPORTS.post_authorisation,
    searchFields: ['name', 'active_substance', 'inn'],
    dateField: 'opinion_date',
    sortField: 'opinion_date',
    categoryFilter: true,
    extraFilter: (r, args) => {
      const status = str(args, 'status')?.toLowerCase();
      return !status || (r.procedure_status ?? '').toLowerCase().includes(status);
    },
    noMatchHint:
      'No post-authorisation procedure matches those filters. Try a broader `query`, drop `status`, or widen `since`.',
  },
};

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'herb_search' || name === 'herb' || name === 'herb_monograph_status') {
    return callHerbalTool(name, args);
  }
  const reportTool = REPORT_TOOL_SPECS[name];
  if (reportTool) {
    const { spec, ...opts } = reportTool;
    return callReportTool(name, spec, args, opts);
  }

  let d: Dataset;
  try {
    d = await dataset();
  } catch (e) {
    return unavailable(e);
  }
  const category = categoryOf(args);
  const pool = category ? d.medicines.filter((m) => m.category === category) : d.medicines;

  switch (name) {
    case 'ema_recent_approvals': {
      const month = str(args, 'month');
      const from = month ? boundary(month, false) : boundary(str(args, 'from'), false);
      const to = month ? boundary(month, true) : boundary(str(args, 'to'), true);
      const limit = limitOf(args, 50);
      const hits = pool
        .filter((m) => inWindow(m.marketing_authorisation_date, from, to))
        .sort(byDateDesc('marketing_authorisation_date'));
      if (!hits.length) {
        return {
          found: false,
          reason: 'no_approvals_in_window',
          window: { from: from ?? null, to: to ?? null },
          hint:
            'No initial EU marketing authorisation carries a date in that window. Widen the window, or call ema_chmp_opinions for medicines recommended by the committee but not yet decided by the European Commission.',
          ...provenance(d),
        };
      }
      return {
        found: true,
        window: { from: from ?? null, to: to ?? null },
        date_field:
          'marketing_authorisation_date — the date an initial EU marketing authorisation was granted. The European Commission decision date also moves on post-authorisation variations, so it counts changes rather than new medicines.',
        count: hits.length,
        approvals: hits.slice(0, limit).map((m) => summarize(m)),
        ...provenance(d),
      };
    }

    case 'ema_chmp_opinions': {
      const wanted = (str(args, 'opinion_status') ?? 'positive').toLowerCase();
      const since = boundary(str(args, 'since'), false);
      const includeDecided = args.include_decided === true || String(args.include_decided) === 'true';
      const limit = limitOf(args, 50);
      const base = pool
        .filter((m) => m.opinion_status)
        // Medicine status "Opinion" (or "Opinion under re-examination") is what
        // marks an opinion as still awaiting the Commission. Authorised and
        // withdrawn products keep their old opinion field, so without this the
        // pending pipeline gets padded with medicines decided years ago.
        .filter((m) => (includeDecided ? true : (m.medicine_status ?? '').startsWith('Opinion')))
        .filter((m) => (wanted === 'any' || wanted === 'all' ? true : (m.opinion_status ?? '').toLowerCase() === wanted))
        .sort(byDateDesc('opinion_adopted_date'));
      let hits = since ? base.filter((m) => (m.opinion_adopted_date ?? '') >= since) : base;
      // The committees meet monthly, so "what did the CHMP recommend this month"
      // lands on an empty window for most of every month. The question is about
      // the pipeline, not the calendar: fall back to the opinions that ARE
      // outstanding and say plainly that none were adopted in the asked window.
      let windowNote: string | undefined;
      if (since && !hits.length && base.length) {
        hits = base;
        windowNote = `No committee opinion was adopted on or after ${since}. The committees meet monthly, so these are the outstanding opinions instead — the most recent was adopted ${base[0].opinion_adopted_date}.`;
      }
      if (!hits.length) {
        return {
          found: false,
          reason: 'no_opinions_match',
          hint:
            'No committee opinion in the register matches those filters. Try opinion_status "any", set include_decided true, drop `since`, or call ema_recent_approvals for medicines the European Commission has already authorised.',
          ...provenance(d),
        };
      }
      return {
        found: true,
        opinion_status: wanted,
        awaiting_commission_decision: !includeDecided,
        ...(windowNote ? { since_requested: since, window_note: windowNote } : {}),
        note:
          'A committee opinion is a recommendation. The European Commission decision that turns a positive opinion into an EU marketing authorisation typically follows within about two months.',
        count: hits.length,
        opinions: hits.slice(0, limit).map((m) => summarize(m)),
        ...provenance(d),
      };
    }

    case 'ema_medicine_search': {
      const query = str(args, 'query');
      if (!query) {
        return { found: false, reason: 'missing_query', hint: 'Pass query — a brand name, active substance, company or ATC code.' };
      }
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const status = str(args, 'status')?.toLowerCase();
      const orphanOnly = args.orphan_only === true || String(args.orphan_only) === 'true';
      const limit = limitOf(args, 25);
      let hits = pool.filter((m) => matches(m, terms, SEARCH_FIELDS));
      if (status) hits = hits.filter((m) => (m.medicine_status ?? '').toLowerCase() === status);
      if (orphanOnly) hits = hits.filter((m) => m.orphan_medicine === 'Yes');
      // Exact and prefix name matches first — an agent searching "Ozempic"
      // wants the product, not every record whose indication mentions it.
      const q = query.toLowerCase();
      hits.sort((a, b) => {
        const rank = (m: Medicine) => {
          const n = (m.name ?? '').toLowerCase();
          if (n === q) return 0;
          if (n.startsWith(q)) return 1;
          if ((m.inn ?? '').toLowerCase() === q || (m.active_substance ?? '').toLowerCase() === q) return 2;
          return 3;
        };
        const r = rank(a) - rank(b);
        return r !== 0 ? r : (b.marketing_authorisation_date ?? '').localeCompare(a.marketing_authorisation_date ?? '');
      });
      if (!hits.length) {
        return {
          found: false,
          reason: 'no_match',
          query,
          hint:
            'Nothing in the EU centrally authorised register matches that. The register covers medicines approved through the EMA centralised procedure — nationally authorised products are not in it. For a US approval or label, use the openfda pack.',
          ...provenance(d),
        };
      }
      return {
        found: true,
        query,
        count: hits.length,
        medicines: hits.slice(0, limit).map((m) => summarize(m)),
        ...provenance(d),
      };
    }

    case 'ema_medicine': {
      const key = str(args, 'name');
      if (!key) return { found: false, reason: 'missing_name', hint: 'Pass name — a brand name or EMA product number.' };
      const k = key.toLowerCase();
      const exact =
        pool.find((m) => (m.name ?? '').toLowerCase() === k) ??
        pool.find((m) => (m.ema_product_number ?? '').toLowerCase() === k);
      if (exact) return { found: true, medicine: exact, ...provenance(d) };
      const near = pool
        .filter((m) => (m.name ?? '').toLowerCase().includes(k) || (m.inn ?? '').toLowerCase().includes(k))
        .slice(0, 10)
        .map((m) => ({ name: m.name, inn: m.inn, medicine_status: m.medicine_status, ema_product_number: m.ema_product_number }));
      return {
        found: false,
        reason: 'no_exact_match',
        query: key,
        candidates: near,
        hint: near.length
          ? 'No exact match. Retry ema_medicine with one of the candidate names.'
          : 'No medicine with that name in the EU centrally authorised register. Try ema_medicine_search, which also searches active substance, indication text and holder.',
        ...provenance(d),
      };
    }

    case 'ema_recent_updates': {
      const since = boundary(str(args, 'since'), false);
      const status = str(args, 'status')?.toLowerCase();
      const limit = limitOf(args, 25);
      let hits = pool.filter((m) => m.last_updated_date);
      if (since) hits = hits.filter((m) => (m.last_updated_date ?? '') >= since);
      if (status) hits = hits.filter((m) => (m.medicine_status ?? '').toLowerCase() === status);
      hits = hits.sort(byDateDesc('last_updated_date'));
      if (!hits.length) {
        return {
          found: false,
          reason: 'no_updates_match',
          hint: 'No register entry was updated in that window with that status. Widen `since` or drop `status`.',
          ...provenance(d),
        };
      }
      return {
        found: true,
        count: hits.length,
        updates: hits.slice(0, limit).map((m) => summarize(m, ['last_updated_date', 'authorisation_end_date', 'suspension_date', 'revision_number'])),
        ...provenance(d),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
