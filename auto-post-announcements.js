// auto-post-announcements.js
// Unattended runner for Windows Task Scheduler.
//
// What it does on each invocation:
//   1. Fetch top N ShareSansar announcements (via fetch-announcements.js logic)
//   2. Query backend for already-posted Announcement slugs
//   3. Filter out any items whose slug already exists (slug-dedup)
//   4. POST the remainder to /news (via batch-post-news.js --auto)
//   5. Log everything with ISO timestamps to stdout
//   6. Exit 0 on success, non-zero on hard failure (Task Scheduler then sees failure)
//
// Usage:
//   node auto-post-announcements.js              → fetch 5, dedup, post new ones
//   node auto-post-announcements.js --count=10   → fetch 10 instead of 5
//   node auto-post-announcements.js --dry-run    → fetch + dedup but don't post
//
// Intended to be triggered by Task Scheduler every 30 min during business
// windows (7-10 AM and 4-8 PM NPT). Multiple runs back-to-back are safe
// because of the slug-dedup pass — same items won't be reposted.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// ─── Config ───
const API_BASE = "https://api.nepsetrading.com";
const FETCH_SCRIPT = path.join(__dirname, "fetch-announcements.js");
const POST_SCRIPT = path.join(__dirname, "batch-post-news.js");
const JSON_FILE = path.join(__dirname, "news-announcements.json");
const ANNOUNCEMENT_TAG = "Announcement";
// Fetch top 40 per cron run — observed ShareSansar publishing 28-40
// announcements/day at peak (quarterly-result season hits hardest, with
// every mutual fund + listed company posting balance sheets together).
// With pagination active, this walks pages 1-2-3 of ShareSansar's list
// (up to ~45 items) on each cron firing.
//
// Why 40 and not 60: each "skip" pass still does an HTTP HEAD on the
// detail page (~50ms each), so larger fetches add a constant overhead even
// when cached. 40 strikes a balance between catching slow-cron-after-gap
// scenarios and keeping each cron tick lightweight.
//
// Cost impact is bounded by the source-URL cache: items already posted
// skip the OCR step entirely (only the detail page is checked), so
// steady-state Gemini cost scales with NEW items per day, not with the
// fetch count.
const DEFAULT_FETCH_COUNT = 40;
const DEDUP_LOOKUP_LIMIT = 100; // matches larger fetch window

// Source-URL cache file — shared with fetch-announcements.js. Both scripts
// READ from it; only THIS script writes to it (appending after a successful
// post). See the long comment in fetch-announcements.js for the rationale.
const POSTED_URLS_CACHE_FILE = path.join(__dirname, ".posted-source-urls.json");
const POSTED_URLS_CACHE_CAP = 500; // keep cache bounded — older entries fall off

function loadPostedUrls() {
  if (!fs.existsSync(POSTED_URLS_CACHE_FILE)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(POSTED_URLS_CACHE_FILE, "utf-8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function appendPostedUrls(newEntries) {
  if (!newEntries || newEntries.length === 0) return;
  const existing = loadPostedUrls();
  const seen = new Set(existing.map((e) => e && e.url).filter(Boolean));
  for (const entry of newEntries) {
    if (!entry || !entry.url || seen.has(entry.url)) continue;
    existing.push(entry);
    seen.add(entry.url);
  }
  const capped =
    existing.length > POSTED_URLS_CACHE_CAP
      ? existing.slice(-POSTED_URLS_CACHE_CAP)
      : existing;
  fs.writeFileSync(
    POSTED_URLS_CACHE_FILE,
    JSON.stringify(capped, null, 2),
    "utf-8"
  );
}

// ─── CLI args ───
const args = process.argv.slice(2);
const hasFlag = (n) => args.includes(`--${n}`);
const getArg = (n) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : null;
};
const cliCount = parseInt(getArg("count") || String(DEFAULT_FETCH_COUNT), 10);
const dryRun = hasFlag("dry-run");
// Forward --max-age-days to fetch-announcements.js (defaults to 1 = today only).
// To catch up older items pass --max-age-days=N (e.g. 7 for last week).
const cliMaxAgeDays = parseInt(getArg("max-age-days") || "1", 10);

// ─── Logging ───
function log(level, msg) {
  const ts = new Date().toISOString();
  // Use stdout for all levels — Task Scheduler captures stdout fine, and
  // splitting across stdout/stderr would split the log file weirdly.
  console.log(`${ts} [${level}] ${msg}`);
}

// ─── Fetch existing Announcement slugs from backend ───
//
// Retries on transient 5xx errors (502/503/504) and network failures. The
// backend sits behind Cloudflare + a load balancer, so a single 502 from
// a cold upstream or a brief gateway hiccup shouldn't kill the whole cron
// run — the next retry after a short backoff usually succeeds.
//
// We always drain the response body before throwing, otherwise Node keeps
// the underlying TCP connection "in use" and process.exit() trips a libuv
// assertion on Windows (UV_HANDLE_CLOSING in src\win\async.c:76).
const DEDUP_FETCH_RETRY_DELAYS_MS = [2000, 5000, 12000]; // 3 retries, ~19s total worst-case

function isTransientHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

async function fetchExistingSlugs() {
  const url = `${API_BASE}/news?tags=${encodeURIComponent(ANNOUNCEMENT_TAG)}&limit=${DEDUP_LOOKUP_LIMIT}&latest=true`;
  log("info", `Querying existing announcement slugs: ${url}`);

  let lastErr = null;
  for (let attempt = 0; attempt <= DEDUP_FETCH_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const wait = DEDUP_FETCH_RETRY_DELAYS_MS[attempt - 1];
      log("warn", `Retrying in ${wait / 1000}s (attempt ${attempt + 1}/${DEDUP_FETCH_RETRY_DELAYS_MS.length + 1})...`);
      await new Promise((r) => setTimeout(r, wait));
    }

    let res;
    try {
      res = await fetch(url);
    } catch (netErr) {
      // DNS failure, connection reset, etc. — treat as transient and retry.
      lastErr = new Error(`Network error: ${netErr.message}`);
      continue;
    }

    if (res.ok) {
      const json = await res.json();
      const items = Array.isArray(json.data) ? json.data : [];
      const slugs = new Set(items.map((it) => it.slug).filter(Boolean));
      log("info", `Found ${slugs.size} existing Announcement slug(s) on backend.`);
      return slugs;
    }

    // Non-OK: capture error and drain the body so libuv can release the
    // TCP socket cleanly (prevents the assertion crash on exit).
    const bodyHead = await res.text().catch(() => "");
    lastErr = new Error(
      `Failed to fetch existing slugs: ${res.status} ${res.statusText}` +
        (bodyHead ? ` — ${bodyHead.replace(/\s+/g, " ").substring(0, 200)}` : "")
    );

    if (!isTransientHttpStatus(res.status)) {
      // Permanent error (400, 401, 403, etc.) — fail fast, no retry.
      throw lastErr;
    }
    log("warn", `Backend returned ${res.status} ${res.statusText} (transient — will retry)`);
  }

  throw lastErr || new Error("fetchExistingSlugs: exhausted retries with no specific error");
}

// ─── Run fetch-announcements.js as a subprocess; it writes news-announcements.json ───
function runFetch(count) {
  log(
    "info",
    `Spawning fetch-announcements.js --count=${count} --max-age-days=${cliMaxAgeDays}`
  );
  const result = spawnSync(
    process.execPath, // node binary path
    [FETCH_SCRIPT, `--count=${count}`, `--max-age-days=${cliMaxAgeDays}`],
    {
      cwd: __dirname,
      stdio: "inherit", // forward child output to our stdout/stderr
      windowsHide: true,
    }
  );
  if (result.status !== 0) {
    throw new Error(`fetch-announcements.js exited with status ${result.status}`);
  }
  if (!fs.existsSync(JSON_FILE)) {
    throw new Error(`fetch-announcements.js completed but ${JSON_FILE} is missing.`);
  }
}

// ─── Read the fetched JSON and dedup against existing slugs ───
function loadAndDedup(existingSlugs) {
  const raw = fs.readFileSync(JSON_FILE, "utf-8");
  const items = JSON.parse(raw);
  if (!Array.isArray(items)) {
    throw new Error("news-announcements.json is not an array.");
  }
  log("info", `Fetched ${items.length} item(s) from ShareSansar.`);

  // Source-URL cache — primary dedup. Catches items that survived the
  // pre-OCR cache check in fetch-announcements.js (e.g. cache was empty
  // when fetch started but got populated by a parallel run, or cache is
  // out of sync). Items already in the cache get skipped before the
  // title-fingerprint check below.
  const postedUrlSet = new Set(loadPostedUrls().map((e) => e && e.url).filter(Boolean));

  // Each fetched item has english_title + nepali_title; the backend generates
  // the slug from english_title on POST. We don't know the EXACT backend slug
  // ahead of time (the backend may apply its own length-cap or stop-word
  // rules), so we use a bidirectional prefix match on the full slugified
  // title — covers all three cases:
  //   - our fingerprint === backend slug exactly        (most common)
  //   - backend slug is shorter (length cap, suffix-id) → fp.startsWith(slug)
  //   - backend slug is longer  (date suffix)           → slug.startsWith(fp)
  //
  // We use the FULL slugified title (no 40-char truncation) to avoid the
  // collision case where two distinct notices share the first 40 chars
  // (common during quarterly season: "Some Bank Limited's Q3 Unaudited
  // Financial Report" vs "...Financial Statement").
  const fingerprint = (title) =>
    String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const fresh = [];
  // URLs of items we identified as duplicates this run. Cached even though
  // we didn't post them — so the NEXT run's pre-OCR cache check in
  // fetch-announcements.js skips them before burning Gemini API quota.
  const dedupedUrlEntries = [];
  let skipped = 0;
  for (const it of items) {
    // Source-URL dedup (primary, definitive). The URL is stable across
    // re-fetches; the title isn't.
    const sourceUrl = it._internal_source_url || "";
    if (sourceUrl && postedUrlSet.has(sourceUrl)) {
      log("info", `[dedup-url] skipping (source URL already posted): ${sourceUrl}`);
      skipped++;
      continue;
    }

    // Title-fingerprint dedup (secondary fallback). Catches items posted
    // before the source-URL cache was introduced, or items whose URL got
    // dropped from the cache due to the 500-entry cap.
    const fp = fingerprint(it.english_title || it.nepali_title);
    if (!fp) {
      log("warn", "Skipping item with empty title.");
      skipped++;
      continue;
    }
    const isDup = Array.from(existingSlugs).some(
      (s) => s === fp || s.startsWith(fp + "-") || fp.startsWith(s + "-") || s.startsWith(fp) && (s.length - fp.length) <= 15
    );
    if (isDup) {
      log("info", `[dedup-title] skipping (slug already exists): ${(it.english_title || "").substring(0, 80)}`);
      skipped++;
      // Cache the URL so the next run pre-OCR-skips this item. We didn't
      // post it this run, but it IS on the backend (matched by title) —
      // future re-fetches should bypass it.
      if (sourceUrl) {
        dedupedUrlEntries.push({
          url: sourceUrl,
          title: (it.english_title || it.nepali_title || "").substring(0, 120),
          postedAt: new Date().toISOString(),
          note: "discovered-via-title-fingerprint-match",
        });
      }
    } else {
      fresh.push(it);
    }
  }

  // Persist deduped URLs immediately — independent of whether the post step
  // for `fresh` succeeds. These items are already on the backend; we just
  // didn't know their source URLs until this run.
  if (dedupedUrlEntries.length > 0) {
    appendPostedUrls(dedupedUrlEntries);
    log("info", `Cached ${dedupedUrlEntries.length} source URL(s) for already-posted duplicates.`);
  }

  log("info", `${fresh.length} new item(s) to post, ${skipped} skipped as duplicates.`);
  return fresh;
}

// ─── Write filtered list back to JSON and post ───
function writeAndPost(fresh) {
  fs.writeFileSync(JSON_FILE, JSON.stringify(fresh, null, 2), "utf-8");

  if (dryRun) {
    log("info", `[dry-run] Would post ${fresh.length} item(s). Skipping batch-post-news.js.`);
    return;
  }

  log("info", `Spawning batch-post-news.js --file=${path.basename(JSON_FILE)} --auto`);
  const result = spawnSync(
    process.execPath,
    [POST_SCRIPT, `--file=${JSON_FILE}`, "--auto"],
    {
      cwd: __dirname,
      stdio: "inherit",
      windowsHide: true,
    }
  );
  if (result.status !== 0) {
    throw new Error(`batch-post-news.js exited with status ${result.status}`);
  }

  // Success — append every posted item's source URL to the local cache
  // so the next run's pre-OCR check + secondary dedup will skip them.
  // We append ALL items rather than checking the actual backend response
  // because batch-post-news.js uses inherit-stdio (we don't get a
  // machine-readable success/fail map). The cap-at-500 keeps the file
  // bounded; items that fall off get caught by the title-fingerprint
  // fallback in the next loadAndDedup pass.
  const cacheEntries = fresh
    .filter((it) => it && it._internal_source_url)
    .map((it) => ({
      url: it._internal_source_url,
      title: (it.english_title || it.nepali_title || "").substring(0, 120),
      postedAt: new Date().toISOString(),
    }));
  appendPostedUrls(cacheEntries);
  log("info", `Cached ${cacheEntries.length} source URL(s) in ${path.basename(POSTED_URLS_CACHE_FILE)}`);
}

// ─── Main ───
// Uses `process.exitCode = N` instead of `process.exit(N)` so any pending
// async handles (HTTP sockets from the dedup query, sub-process pipes from
// spawnSync, etc.) get drained naturally before the process exits. Calling
// process.exit() directly trips a libuv assertion on Windows when there
// are still-closing handles:
//   "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76"
// The bat wrapper still gets the right %ERRORLEVEL% because setting
// process.exitCode propagates to the actual exit status when main() returns.
(async () => {
  log("info", `=== auto-post-announcements starting (count=${cliCount}, dryRun=${dryRun}) ===`);
  try {
    const existing = await fetchExistingSlugs();
    runFetch(cliCount);
    const fresh = loadAndDedup(existing);

    if (fresh.length === 0) {
      log("info", "Nothing new to post. Exiting cleanly.");
      log("info", `=== auto-post-announcements done ===`);
      process.exitCode = 0;
      return;
    }

    writeAndPost(fresh);
    log("info", `=== auto-post-announcements done ===`);
    process.exitCode = 0;
  } catch (err) {
    log("error", `FATAL: ${err && err.message ? err.message : err}`);
    log("error", `=== auto-post-announcements FAILED ===`);
    process.exitCode = 1;
  }
})();
