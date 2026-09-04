// fetch-announcements.js
// Scrapes ShareSansar's announcement list, OCRs each notice image via
// Google Gemini Vision API, and writes news-announcements.json for posting
// via batch-post-news.js.
//
// Usage:
//   node fetch-announcements.js                  → interactive, writes news-announcements.json
//   node fetch-announcements.js --count=N        → non-interactive count override
//   node fetch-announcements.js --dry-run        → fetch ONE item, print JSON to stdout, no file write
//
// OCR backend: Google Generative Language API (Gemini). Requires:
//   - GEMINI_API_KEY env var, OR .gemini-key file in this directory.
//   - Get a free key at https://aistudio.google.com/apikey (no card required).
// Default model: gemini-2.5-flash (free tier: 1500 requests/day).
//   Override with GEMINI_MODEL env var or .gemini-model file.
//
// thumb_nail is always empty in the output. Backend (src/socials/news.rs:55)
// accepts an empty thumbnail; the new "Announcements" homepage section does
// not depend on images.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
// sharp: used to split tall stitched multi-page notice images into
// page-sized chunks before sending to Gemini OCR. Without splitting,
// gemini-2.5-flash aggressively downscales tall images to fit its visual
// input window, which makes small Devanagari digits unreadable on
// pages 2+ and causes the model to "fill in" with hallucinated/repeated
// values. Per-chunk OCR keeps each page at full resolution.
const sharp = require("sharp");

// ─── Config ───
const LIST_URL = "https://www.sharesansar.com/announcement";
const OUTPUT_FILE = path.join(__dirname, "news-announcements.json");
// Per-item OCR/parse failures from the last run. Written EVERY run (emptied
// when clean) so auto-post-announcements.js can fail the run AFTER posting the
// items that did succeed. Exiting non-zero from here instead would make
// runFetch() throw and skip the posting step, turning a partial failure into a
// total one.
const FAILURES_FILE = path.join(__dirname, "news-announcements.failures.json");
const ANNOUNCEMENT_TAG = "Announcement";
const POLITE_DELAY_MS = 1500;
const DEFAULT_COUNT = 5;

// ─── Category-image URL resolution ───
//
// Mirrors the frontend's announcement-category-image.ts logic so each
// posted announcement gets thumbnail_url populated with the correct
// category image URL. Without this the admin "Manage News" panel shows
// no thumbnail next to each item (it reads thumbnail_url directly,
// doesn't run the frontend helper's fallback chain).
//
// IMPORTANT: keep SHIPPED_CATEGORY_IMAGES and CATEGORY_ALIASES below in
// sync with nepse-trading-frontend/src/utils/announcement-category-image.ts.
// They're duplicated here (rather than imported) because that file is a
// TypeScript module in a different project; reimplementing in plain JS
// keeps this script self-contained.
const FRONTEND_BASE_URL = "https://nepsetrading.com";
const CATEGORY_IMAGE_BASE = "/announcements/categories";
// Category icon file extension. Changed from "png" to "webp" 2026-05-29 —
// the icons in public/announcements/categories/ were converted to WebP for
// the DebugBear "use modern image formats" win. MUST match IMAGE_EXT in
// nepse-trading-frontend/src/utils/announcement-category-image.ts.
const CATEGORY_IMAGE_EXT = "webp";

const SHIPPED_CATEGORY_IMAGES = new Set([
  // Combined-category slugs (canonical ShareSansar names):
  "default",
  "agm-special-agm",
  "auction",
  "book-closure",
  "breaking-news",
  "financial-analysis",
  "interest-rates",
  "mutual-fund",
  "notice",
  "share-allotment",
  "share-listed",
  "stock-market",
  // Granular alias slugs (used via CATEGORY_ALIASES below):
  "acquisition",
  "bonds",
  "bonus",
  "debenture",
  "dividend",
  "fpo-news",
  "international-news",
  "ipo-news",
  "merger",
  "rights",
  "treasury-bills",
]);

const CATEGORY_ALIASES = {
  "dividend-bonus-rights": ["dividend", "bonus", "rights"],
  "bonds-debentures": ["bonds", "debenture", "debentures"],
  "ipo-fpo-news": ["ipo-news", "fpo-news", "ipo", "fpo"],
  "merger-acquisition": ["merger", "acquisition"],
  "treasury-bill": ["treasury-bills", "treasury"],
  "treasury-bills": ["treasury-bill", "treasury"],
  international: ["international-news"],
};

function slugifyCategory(category) {
  if (!category) return "";
  return String(category)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Returns the absolute URL of the category image to use as thumbnail_url,
// or "" if nothing matches (callers should leave the field empty rather
// than guessing — the frontend's category-image helper handles the
// fallback at render time for items without thumbnail_url).
function resolveCategoryImageUrl(category) {
  const slug = slugifyCategory(category);
  let chosen = "";
  if (slug) {
    if (SHIPPED_CATEGORY_IMAGES.has(slug)) {
      chosen = slug;
    } else {
      const aliases = CATEGORY_ALIASES[slug];
      if (aliases) {
        chosen = aliases.find((a) => SHIPPED_CATEGORY_IMAGES.has(a)) || "";
      }
    }
  }
  if (!chosen && SHIPPED_CATEGORY_IMAGES.has("default")) {
    chosen = "default";
  }
  if (!chosen) return "";
  return `${FRONTEND_BASE_URL}${CATEGORY_IMAGE_BASE}/${chosen}.${CATEGORY_IMAGE_EXT}`;
}

// ─── Posted-URL cache (source-URL-based dedup) ───
//
// ShareSansar's detail URL is a stable per-notice identifier. Gemini's
// english_title is non-deterministic — running OCR on the same notice
// twice produces slightly different short titles → different backend slugs
// → the title-fingerprint dedup in auto-post-announcements.js misses them
// → duplicate posts accumulate every 30 minutes.
//
// Fix: maintain a local JSON cache of every source URL we've successfully
// posted. fetchAndProcessOne checks this cache BEFORE calling Gemini, so
// duplicates are skipped without burning API quota. auto-post-announcements.js
// appends newly-posted URLs to this cache after batch-post succeeds.
//
// Cache file format:
//   [{ "url": "https://www.sharesansar.com/...", "slug": "...", "postedAt": "ISO" }, ...]
const POSTED_URLS_CACHE_FILE = path.join(__dirname, ".posted-source-urls.json");

function loadPostedUrlsCache() {
  if (!fs.existsSync(POSTED_URLS_CACHE_FILE)) return new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(POSTED_URLS_CACHE_FILE, "utf-8"));
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((e) => e && e.url).filter(Boolean));
  } catch {
    return new Set();
  }
}

const POSTED_URLS_CACHE = loadPostedUrlsCache();
const MAX_COUNT = 50;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,ne;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

// ─── CLI args ───
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const cliCount = (() => {
  const a = args.find((x) => x.startsWith("--count="));
  if (!a) return null;
  const n = parseInt(a.split("=")[1], 10);
  return Number.isFinite(n) ? n : null;
})();
// --skip=N skips the first N announcements in the list before processing.
// Useful for testing a specific notice (e.g. one with tables) without
// having to delete posts above it. Combined with --dry-run, fetches just
// the (N+1)th notice and prints its JSON.
//   --skip=1            → start at the 2nd announcement
//   --skip=2 --count=1  → fetch only the 3rd announcement
const cliSkip = (() => {
  const a = args.find((x) => x.startsWith("--skip="));
  if (!a) return 0;
  const n = parseInt(a.split("=")[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

// --max-age-days=N — only fetch items whose ShareSansar-list date is within
// the last N days (counting "today" as day 0). Default is 1 (today only).
// Why this exists: ShareSansar's listing page shows ~15-20 items per page
// and older items can hang around for days, so paginated fetches can grab
// stale items. With this filter the cron only processes items posted on
// the current day, keeping the news feed fresh.
//
// To catch up older items manually (e.g. after a multi-day outage), pass
// --max-age-days=7 (last week) or higher.
const cliMaxAgeDays = (() => {
  const a = args.find((x) => x.startsWith("--max-age-days="));
  if (!a) return 1; // default: today only
  const n = parseInt(a.split("=")[1], 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
})();

// --url=https://www.sharesansar.com/announcementdetail/<slug>
// Bypass the list-page scan and process exactly this one announcement.
// Works in both --dry-run mode (print only) and normal mode (write to
// news-announcements.json so it can be posted via batch-post-news.js).
// Useful for testing a known notice URL or backfilling a single notice
// that's already aged off the front of the list page.
const cliUrl = (() => {
  const a = args.find((x) => x.startsWith("--url="));
  if (!a) return null;
  const v = a.substring("--url=".length).trim();
  if (!v) return null;
  if (!/^https?:\/\/(www\.)?sharesansar\.com\/announcementdetail\//i.test(v)) {
    console.error(
      `--url must point to a sharesansar.com/announcementdetail/... URL, got: ${v}`
    );
    process.exit(1);
  }
  return v;
})();

// --classify-test=FILE — offline harness. Runs cleanOcrText → classifyLine →
// structureToHtml → detectFinancialTables on a local text file, printing the
// per-line classification and the final HTML. Exactly the production path used
// to build english_content / nepali_content, with NO network, NO Gemini key and
// NO posting. Used to verify the table-detection regression table.
const cliClassify = (() => {
  const a = args.find((x) => x.startsWith("--classify-test="));
  return a ? a.substring("--classify-test=".length).trim() : null;
})();

// ─── readline ───
let _rl;
function getRL() {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
function closeRL() {
  if (_rl) { _rl.close(); _rl = null; }
}
function prompt(q) {
  return new Promise((r) => getRL().question(q, (a) => r(a.trim())));
}

async function askCount() {
  while (true) {
    const a = await prompt(`How many announcements to fetch? (1-${MAX_COUNT}, default ${DEFAULT_COUNT}): `);
    if (!a) return DEFAULT_COUNT;
    const n = parseInt(a, 10);
    if (!isNaN(n) && n >= 1 && n <= MAX_COUNT) return n;
    console.log(`   Enter a number between 1 and ${MAX_COUNT}`);
  }
}

// ─── HTML helpers ───
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Image URL extraction (multi-selector fallback) ───
function findImageUrl(html) {
  const probes = [
    /<img[^>]+id=["']announcement-image["'][^>]+src=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+)["'][^>]+id=["']announcement-image["']/i,
    /<img[^>]+class=["'][^"']*\bannouncement-image\b[^"']*["'][^>]+src=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*\bannouncement-image\b/i,
    /<div[^>]+id=["']newsdetail-content["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/i,
    /<img[^>]+src=["'](https?:\/\/content\.sharesansar\.com\/[^"']+)["']/i,
  ];
  for (const re of probes) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return "";
}

// ─── Parsers ───
function parseAnnouncementList(html, limit) {
  const results = [];
  const seen = new Set();
  const blocks = html.split(/<div class="featured-news-list/);
  for (const block of blocks.slice(1)) {
    const hrefMatch = block.match(
      /href="(https:\/\/www\.sharesansar\.com\/announcementdetail\/[^"]+)"/
    );
    const titleMatch = block.match(
      /<h4 class="featured-announcement-title">([\s\S]*?)<\/h4>/
    );
    const dateMatch = block.match(/<span class="text-org">([\s\S]*?)<\/span>/);
    if (!hrefMatch || !titleMatch) continue;
    const url = hrefMatch[1];
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({
      url,
      title: decodeEntities(stripTags(titleMatch[1])),
      date: dateMatch ? decodeEntities(stripTags(dateMatch[1])) : "",
    });
    if (results.length >= limit) break;
  }
  return results;
}

// ─── Date filtering ───
//
// ShareSansar lists items newest-first with a date string like
// "Monday, May 25, 2026" inside <span class="text-org">. We parse it into
// a Date and filter out items older than `maxAgeDays` from today
// (where today=0, yesterday=1, etc).
//
// `parseAnnouncementDate` returns null on parse failure. Callers should
// treat null as "fail open" (don't filter — better to include a possibly-
// old item than to silently drop a real one because of a format change).

function parseAnnouncementDate(dateStr) {
  if (!dateStr) return null;
  // Strip leading weekday name + comma+space (e.g. "Monday, May 25, 2026"
  // → "May 25, 2026") so JS Date parsing handles it reliably.
  const cleaned = String(dateStr).replace(
    /^\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*[,\s]+/i,
    ""
  ).trim();
  const d = new Date(cleaned);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function isItemWithinAgeDays(item, maxAgeDays) {
  const itemDate = parseAnnouncementDate(item.date);
  if (!itemDate) return true; // Unparseable date → fail open (include it)
  const now = new Date();
  // Compare midnight-anchored local dates so timezones don't slip the
  // comparison by ±1 day.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const item0 = new Date(itemDate.getFullYear(), itemDate.getMonth(), itemDate.getDate());
  const diffDays = Math.round((today - item0) / (1000 * 60 * 60 * 24));
  return diffDays >= 0 && diffDays < maxAgeDays;
}

// ─── Pagination-aware list fetcher ───
//
// ShareSansar's announcement listing page only shows ~15-20 entries per
// page. When the cron only sees page 1 and ShareSansar has published more
// items than fit on it (e.g. across the 5.5h gap between the morning
// 10:30 AM cron window end and the evening 4 PM start), older items
// silently age off and never get fetched.
//
// This walks pages 1..MAX_LIST_PAGES, accumulating unique items until we
// hit `limit` OR a page returns no new items. Polite 1s delay between
// page fetches so we don't hammer ShareSansar.
//
// URL pattern: ShareSansar uses `?page=N` for pagination (verified). The
// first page works with or without `?page=1`.
const MAX_LIST_PAGES = 5;            // safety ceiling (5 pages × ~15-20 items = ~100 items)
const LIST_PAGE_DELAY_MS = 1000;     // be nice to ShareSansar's server

// Find the "Next »" pagination link in a ShareSansar listing page's HTML.
// ShareSansar uses CURSOR-based pagination (the URL has a base64-encoded
// `?cursor=...` token, not `?page=N`). The cursor is opaque — we just
// extract the full href from the "Next" anchor and use it verbatim for
// the next fetch. Confirmed via probe-pagination.js (none of ?page=N /
// ?p=N / ?offset=N work — they all return page 1).
//
// The Next link in the HTML looks roughly like (varies slightly):
//   <a href="https://www.sharesansar.com/announcement?cursor=eyJwdWJ..." rel="next">Next »</a>
// We try `rel="next"` first (most reliable), then fall back to anchor
// text matching "Next" near a cursor-bearing href.
function findNextPageHref(html, currentUrl) {
  // 1) rel="next" attribute (either order of href/rel)
  const relPatterns = [
    /href=["']([^"']*?cursor=[^"']+)["'][^>]*\brel=["']next["']/i,
    /\brel=["']next["'][^>]*href=["']([^"']*?cursor=[^"']+)["']/i,
  ];
  for (const re of relPatterns) {
    const m = html.match(re);
    if (m) return resolveSharesansarUrl(decodeEntities(m[1]), currentUrl);
  }
  // 2) Anchor whose visible text contains "Next" and whose href has cursor=
  const textMatch = html.match(
    /<a[^>]+href=["']([^"']*?cursor=[^"']+)["'][^>]*>(?:[^<]*?)Next/i
  );
  if (textMatch) return resolveSharesansarUrl(decodeEntities(textMatch[1]), currentUrl);
  return null;
}

function resolveSharesansarUrl(href, baseUrl) {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("/")) return "https://www.sharesansar.com" + href;
  // Query-only relative URL (e.g. "?cursor=eyJ..."). ShareSansar's
  // pagination Next link is emitted in this form — combine with the
  // current page's path (strip existing query string).
  if (href.startsWith("?")) {
    const base = (baseUrl || LIST_URL).split("?")[0];
    return base + href;
  }
  return "https://www.sharesansar.com/" + href;
}

async function fetchAnnouncementList(limit) {
  const all = [];
  const seenUrls = new Set();
  let ageFilteredOut = 0;
  // Cursor-based pagination: start at page 1, then follow the "Next »" link's
  // href (containing the base64-encoded cursor) for each subsequent page.
  let nextUrl = LIST_URL;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const res = await fetch(nextUrl, { headers: BROWSER_HEADERS });
    if (!res.ok) {
      // Page fetch failed — return what we have so far. Don't throw because
      // page 1 may already have given us enough.
      process.stderr.write(`      [list-paginate] page ${page} returned ${res.status}, stopping\n`);
      break;
    }
    const html = await res.text();
    // Parse with a high cap (limit=999) so we don't truncate the page —
    // the dedup against `seenUrls` handles unique-keeping.
    const pageItems = parseAnnouncementList(html, 999);
    let newOnThisPage = 0;
    let oldItemsOnThisPage = 0;
    for (const it of pageItems) {
      if (seenUrls.has(it.url)) continue;
      seenUrls.add(it.url);
      // Date filter — drop items older than --max-age-days. Items are
      // sorted newest-first by ShareSansar, so once we hit an "old" item
      // on a page, everything after it on the same/later pages will also
      // be old. We track oldItemsOnThisPage to short-circuit pagination
      // when the entire page is too old.
      if (!isItemWithinAgeDays(it, cliMaxAgeDays)) {
        ageFilteredOut++;
        oldItemsOnThisPage++;
        continue;
      }
      all.push(it);
      newOnThisPage++;
      if (all.length >= limit) break;
    }
    // Stop conditions:
    //   - hit the requested limit
    //   - this page returned no NEW (fresh-enough) items, AND had old items
    //     filtered out (we've crossed the age cutoff — no point reading further)
    //   - page returned no items at all (end of feed)
    if (all.length >= limit) break;
    if (pageItems.length === 0) {
      process.stderr.write(`      [list-paginate] page ${page} had no items, stopping\n`);
      break;
    }
    if (newOnThisPage === 0 && oldItemsOnThisPage > 0) {
      process.stderr.write(
        `      [list-paginate] page ${page} only had items older than --max-age-days=${cliMaxAgeDays}, stopping\n`
      );
      break;
    }
    // Find next-page cursor URL from this page's HTML. If absent, we've
    // reached the end of the list (last page). Pass the current URL so
    // relative hrefs like "?cursor=..." resolve against it.
    const nextHref = findNextPageHref(html, nextUrl);
    if (!nextHref) {
      process.stderr.write(
        `      [list-paginate] no "Next" cursor link on page ${page}, end of list\n`
      );
      break;
    }
    nextUrl = nextHref;
    // Polite delay before next page
    if (page < MAX_LIST_PAGES) {
      await new Promise((r) => setTimeout(r, LIST_PAGE_DELAY_MS));
    }
  }
  if (ageFilteredOut > 0) {
    process.stderr.write(
      `      [list-paginate] filtered out ${ageFilteredOut} item(s) older than --max-age-days=${cliMaxAgeDays}\n`
    );
  }
  return all;
}

function parseDetailPage(html, fallbackTitle) {
  const titleMatch = html.match(/<h1[^>]*style="font-size:\s*30px[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const title = titleMatch
    ? decodeEntities(stripTags(titleMatch[1]))
    : fallbackTitle;
  const categoryMatch = html.match(/class="tags"[^>]*>([\s\S]*?)<\/a>/);
  const category = categoryMatch ? decodeEntities(stripTags(categoryMatch[1])) : "";
  const contentMatch = html.match(/<div id="newsdetail-content">([\s\S]*?)<\/div>/);
  const summaryHtml = contentMatch ? contentMatch[1].trim() : "";
  const summaryText = decodeEntities(stripTags(summaryHtml));
  const image = findImageUrl(html);
  return { title, category, summaryHtml, summaryText, image };
}

// ─── Google Gemini Vision OCR ───
//
// Posts the notice image (base64-encoded) to Google's Generative Language
// API. Free tier: 1500 requests/day on gemini-2.5-flash — covers any
// reasonable daily volume of notice posts.
//
// API key: read from GEMINI_API_KEY env var, else from .gemini-key file in
// this directory. Model override: GEMINI_MODEL env var, or .gemini-model
// file. Default: gemini-2.5-flash (best accuracy/cost on the free tier).
//
// The system instruction enforces Devanagari digit preservation, correct
// column reading order, and exclusion of letterhead/footer noise — areas
// where pure-OCR engines (Tesseract, PaddleOCR) struggle on stylized print.

const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
const GEMINI_HIGH_ACCURACY_MODEL = "gemini-2.5-pro";

// Categories that get upgraded to the higher-accuracy model. Currently
// EMPTY because gemini-2.5-pro is paid-tier-only on Google AI Studio
// (free-tier accounts get HTTP 429 with "limit: 0" on every pro call) —
// enabling this routing without a paid Google Cloud project breaks the
// pipeline for every notice in the listed categories.
//
// To re-enable for Financial Analysis after upgrading to paid tier:
//   const HIGH_ACCURACY_CATEGORIES = new Set(
//     ["Financial Analysis"].map((s) => s.toLowerCase())
//   );
//
// Or override the model name globally via env (no per-category routing):
//   set GEMINI_HIGH_ACCURACY_MODEL=gemini-1.5-pro
// (gemini-1.5-pro currently still has a small free-tier allowance.)
const HIGH_ACCURACY_CATEGORIES = new Set();

// Reads ALL available Gemini API keys, in priority order, so we can rotate
// to a backup key when the active one hits a 429 quota exhaustion. Sources
// (later items append to the list, NOT override):
//   1. GEMINI_API_KEY env var — single key OR comma-separated list
//   2. .gemini-key  file  — single key (one line)
//   3. .gemini-keys file  — one key per line (comments starting with # ignored)
// Returns an array; empty array means "no keys configured anywhere".
function getGeminiKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) {
    for (const part of process.env.GEMINI_API_KEY.split(",")) {
      const t = part.trim();
      if (t) keys.push(t);
    }
  }
  const singleFile = path.join(__dirname, ".gemini-key");
  if (fs.existsSync(singleFile)) {
    const k = fs.readFileSync(singleFile, "utf-8").trim();
    if (k) keys.push(k);
  }
  const multiFile = path.join(__dirname, ".gemini-keys");
  if (fs.existsSync(multiFile)) {
    const lines = fs.readFileSync(multiFile, "utf-8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      keys.push(line);
    }
  }
  // De-dupe — preserve first occurrence order, drop later duplicates.
  return Array.from(new Set(keys));
}

// Module-level state — which key index we're currently using. Persists
// across all chunks/notices in a single fetch-announcements.js run, so
// once we've rotated past an exhausted key we don't keep trying it.
let _activeKeyIndex = 0;

function getGeminiKey() {
  const keys = getGeminiKeys();
  if (keys.length === 0) return null;
  // Clamp so we never read past the end of the list (defensive — the
  // rotate logic in ocrSingleImageViaGemini stops before this).
  return keys[Math.min(_activeKeyIndex, keys.length - 1)];
}

// Rotates to the next available key. Returns true if a rotation happened,
// false if there are no more backup keys to try. Called by the OCR layer
// when a 429 (quota exhausted) is returned — never on transient 5xx
// errors (those are normal retry-and-recover, not a key problem).
function rotateGeminiKey() {
  const keys = getGeminiKeys();
  if (_activeKeyIndex + 1 >= keys.length) return false;
  _activeKeyIndex++;
  process.stdout.write(
    `      [key-rotate] active key exhausted (429), switching to backup key ` +
      `${_activeKeyIndex + 1}/${keys.length}\n`
  );
  return true;
}

function getGeminiModel() {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL.trim();
  const modelFile = path.join(__dirname, ".gemini-model");
  if (fs.existsSync(modelFile)) {
    const m = fs.readFileSync(modelFile, "utf-8").trim();
    if (m) return m;
  }
  return GEMINI_DEFAULT_MODEL;
}

// Returns the higher-accuracy override (env GEMINI_HIGH_ACCURACY_MODEL or
// .gemini-pro-model file) or the built-in default. Used only for categories
// in HIGH_ACCURACY_CATEGORIES.
function getGeminiHighAccuracyModel() {
  if (process.env.GEMINI_HIGH_ACCURACY_MODEL) {
    return process.env.GEMINI_HIGH_ACCURACY_MODEL.trim();
  }
  const f = path.join(__dirname, ".gemini-pro-model");
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f, "utf-8").trim();
    if (m) return m;
  }
  return GEMINI_HIGH_ACCURACY_MODEL;
}

// Picks the model to use based on the ShareSansar category. Falls back to
// getGeminiModel() (flash by default) for everything not in the upgraded
// set. Case-insensitive match.
function getGeminiModelForCategory(category) {
  if (category && HIGH_ACCURACY_CATEGORIES.has(String(category).trim().toLowerCase())) {
    return getGeminiHighAccuracyModel();
  }
  return getGeminiModel();
}

function detectImageMimeType(imageUrl) {
  const lower = imageUrl.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

const GEMINI_OCR_SYSTEM_PROMPT = `You are an OCR engine for Nepali stock-market notice images from ShareSansar.

Extract the notice's content AND generate concise headlines. Output JSON.

STRICT EXTRACTION RULES:
1. PRESERVE Devanagari digits exactly. Never transliterate २ to 2, ८ to 8. If the source has ०१२३४५६७८९, output ०१२३४५६७८९.
2. PRESERVE original script. Nepali text stays in Devanagari, English text in Latin.
3. Read multi-column layouts in proper order: left column top-to-bottom completely, then middle, then right.
4. SKIP company letterhead artwork — stylized logos, taglines, decorative borders, "A Wholly Owned Subsidiary of..." attribution.
5. SKIP trailing issue-manager contact blocks at the bottom (Phone:/Fax:/Email:/Website: lines for the registrar or capital-services company).
6. PRESERVE numbered list markers (१., २., ३., or 1., 2., 3.) exactly when they appear in the source. If a notice has a numbered list of conditions/branches/agenda items, output each item with its number prefix INTACT.
7. PRESERVE financial tables — output one row per line, label first then numeric values separated by spaces.
8. Group continuation lines of the same paragraph onto one line. Use blank lines to separate logical paragraphs.

CRITICAL — NUMBERS AND DIGITS (highest priority, these errors are unacceptable on a financial-data site):

A. Transcribe digits CHARACTER-BY-CHARACTER. Never paraphrase, round, estimate, or generate
   a "plausible-looking" number. If a digit is genuinely illegible, write '?' in its place.
   It is FAR better to publish "१,२३?,५६७" with one '?' than "१,२३४,५६७" with one digit guessed.

B. For numbers with thousands separators, COUNT the digit groups and COUNT the commas before
   writing. A common error mode is misreading a 10-digit number "१,४२९,८४०,०५५" (1.4 billion)
   as "९,४२९,८०६.७०" (9 thousand) — verify:
     - How many comma-separated groups? (e.g. 4 groups = billions, 3 = millions)
     - How many digits are in each group?
     - Where exactly is each comma?

C. The Nepali numbering system uses BOTH:
     - Western grouping: १,२३४,५६७ (thousands, every 3 digits)
     - Indian grouping:  १२,३४,५६७  (lakhs, last 3 digits then every 2)
   Preserve whichever the SOURCE uses; do NOT convert between them.

D. The Devanagari danda "।" appears as a decimal separator in some notices
   (e.g. "१५८।०४" = 158.04). Preserve the source's exact separator character —
   do not normalize "।" to "." or vice versa.

E. For numeric values appearing in PARENTHESES (financial convention for negatives like
   "(१,२३४)"), preserve BOTH the opening AND closing parenthesis exactly.

F. Inside FINANCIAL TABLES with multiple columns:
     - Determine the column count from the header row before reading any data rows.
     - For each data row, read the label, then read each numeric cell IN COLUMN ORDER
       (left → right), and verify the number of values written equals the column count.
     - If a cell is empty in the source (blank, "-", or "—"), write "-" explicitly to
       preserve column alignment. NEVER skip empty cells silently.
     - Do not swap, shuffle, or "balance" values between columns. A row's values must
       come from THAT row, in source column order.

G. Self-check pass: before finalising the output, scan back through every numeric value you
   wrote and visually re-verify each digit against the source. If anything looks even slightly
   uncertain, replace the uncertain digit with '?'. Accuracy >> completeness.

OUTPUT JSON SHAPE (exactly these 4 keys):
{
  "short_title_np": "...",
  "short_title_en": "...",
  "content": "...",
  "content_en": "..."
}

WHERE:
- short_title_np: a CONCISE original Nepali headline (40-80 chars). Capture the notice's purpose in your own phrasing — do NOT copy the source notice's full title verbatim. Use Devanagari script. Examples of good titles: "मुक्तिनाथ विकास बैंकको संस्थापक शेयर लिलामी सूचना", "एलएस होराइजन १२ इकाई बिक्री बन्द".
- short_title_en: same in English, 40-80 chars. Original phrasing, not a verbatim copy. Examples: "Muktinath Bikas Bank: Promoter Share Auction", "LS Horizon 12 Unit Sale Closing".
- content: the full extracted notice text per the extraction rules above (NEPALI / Devanagari). Multi-line string with \\n line breaks.
- content_en: a faithful ENGLISH translation of "content". Same structure (paragraphs, numbered sections, financial tables with row-per-line, label-then-numbers format). PRESERVE all numeric values EXACTLY as written in the source — do NOT convert Devanagari digits to Latin (keep "१,४२९,८४०,०५५" as "१,४२९,८४०,०५५", same comma placement, same digit script). Translate only the Nepali prose labels and headings into English (e.g. "वासलात" → "Balance Sheet", "जायजेथा, प्लान्ट र उपकरण" → "Property, Plant and Equipment", "बोधार्थ" → "Cc:", "भवदीय" → "Yours sincerely"). Names of people, companies, and place names stay in English (do NOT transliterate "ओमसिद्धि गुरुङ्ग" — write it as "Omsiddhi Gurung"). The translation should read naturally as English while preserving the document's structure 1:1.

Output ONLY the JSON. No markdown fences, no preamble, no explanation.`;

// Statuses that warrant retry: rate limit, transient server errors.
// 5xx covers Google's UNAVAILABLE/INTERNAL responses. 429 is rate limiting.
function isTransientGeminiStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// Backoff schedule (seconds) — 3 retries total after initial attempt.
const GEMINI_RETRY_DELAYS_MS = [3000, 8000, 20000];

async function callGeminiOnce(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Robust parser for Gemini's text response. Handles five forms:
//   1. Pure JSON: '{ "short_title_np": "...", ... }'
//   2. Markdown-fenced JSON: '```json\n{...}\n```'
//   3. Preamble + JSON: 'Here is the result:\n{...}'
//   4. Brace-less object body: '"short_title_np": "...", "content": "..."'
//      (observed on Salt Trading Q3 — Gemini emitted the field list but the
//       wrapping {} got dropped, presumably from a MAX_TOKENS truncation
//       that bit the closing brace; we synthesize the braces ourselves.)
//   5. Truncated-content recovery: when the above all fail, try to pull just
//      the `"content": "...` substring even if its closing quote/brace is
//      missing — better to publish a partial body than dump raw JSON.
// Returns the parsed object on success, null on hard failure.
// Gemini sometimes returns an ARRAY of record objects instead of one — e.g. a
// single image that holds TWO documents (an AGM/book-closure notice page AND
// the agenda page). Merge them into one record: concatenate content /
// content_en with a blank-line separator and take the first non-empty short
// titles. Without this, a valid `[{...},{...}]` passed JSON.parse but had no
// top-level `.content`, so the caller's `typeof parsed.content === "string"`
// check failed and the raw array text was published as the article body
// (Mabilung Energy AGM, post 4875, 2026-06-11). Non-array input is returned
// unchanged.
function normalizeGeminiRecord(parsed) {
  if (!Array.isArray(parsed)) return parsed;
  const objs = parsed.filter((o) => o && typeof o === "object" && !Array.isArray(o));
  if (objs.length === 0) return null;
  if (objs.length === 1) return objs[0];
  const joinField = (key) =>
    objs
      .map((o) => (typeof o[key] === "string" ? o[key].trim() : ""))
      .filter(Boolean)
      .join("\n\n");
  const firstField = (key) => {
    for (const o of objs) {
      if (typeof o[key] === "string" && o[key].trim()) return o[key].trim();
    }
    return "";
  };
  return {
    content: joinField("content"),
    content_en: joinField("content_en"),
    short_title_np: firstField("short_title_np"),
    short_title_en: firstField("short_title_en"),
  };
}

function tryParseGeminiJson(text) {
  if (!text || typeof text !== "string") return null;

  // 1) Plain JSON
  try {
    return normalizeGeminiRecord(JSON.parse(text));
  } catch {}

  // 2) Strip markdown code fence (with or without "json" hint)
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      return normalizeGeminiRecord(JSON.parse(fenced[1]));
    } catch {}
  }

  // 3) Find first { ... matching last } and try that slice
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return normalizeGeminiRecord(JSON.parse(text.substring(first, last + 1)));
    } catch {}
  }

  // 4) Brace-less body — Gemini sometimes emits the fields without the
  //    wrapping object (e.g. response truncated before the closing `}`,
  //    or the opening `{` was never emitted). Detect by looking for the
  //    field-key pattern and wrap before parsing.
  const looksLikeFields = /^\s*"short_title_(np|en)"\s*:/.test(text) ||
    /^\s*"content"\s*:/.test(text);
  if (looksLikeFields) {
    const trimmed = text.trim().replace(/,\s*$/, "");
    try {
      return JSON.parse("{" + trimmed + "}");
    } catch {}
    // Try with a closing quote+brace if the truncation cut mid-string.
    try {
      return JSON.parse("{" + trimmed + '"}');
    } catch {}
  }

  // 5) Last-resort: extract just the `"content": "..."` value (handles
  //    truncated content that lost its closing quote). Returns whatever
  //    text we can salvage so the user gets *something* instead of the
  //    raw malformed JSON dumped into the article body. Also tries to
  //    salvage `content_en` for the English translation field.
  const unescapeJsonStr = (s) =>
    s
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  const contentMatch = text.match(/"content"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
  if (contentMatch) {
    const enContentMatch = text.match(/"content_en"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
    const npMatch = text.match(/"short_title_np"\s*:\s*"([^"]+)"/);
    const enMatch = text.match(/"short_title_en"\s*:\s*"([^"]+)"/);
    return {
      content: unescapeJsonStr(contentMatch[1]),
      content_en: enContentMatch ? unescapeJsonStr(enContentMatch[1]) : "",
      short_title_np: npMatch ? npMatch[1] : "",
      short_title_en: enMatch ? enMatch[1] : "",
    };
  }

  return null;
}

// ─── Image splitting for multi-page notices ───
//
// ShareSansar serves multi-page PDF notices as one large stitched image.
// The layout varies:
//   - Single page (e.g. 2480×3508)            → one cell, no split
//   - Tall stacked (e.g. 1200×4800)           → split vertically (Nx1 grid)
//   - Wide grid (e.g. Salt Trading 7650×7016) → split into a NxM grid;
//                                                pages laid out left-to-right
//                                                AND top-to-bottom
//
// When sent whole to gemini-2.5-flash, large multi-page images get
// downscaled to fit Gemini's visual input window, which makes small
// Devanagari digits unreadable. Observed failure mode: balance-sheet
// values get "smeared" into a repeated hallucinated default like
// १,४२९,८४०,०५५ across multiple rows.
//
// Fix: detect when image dimensions exceed a target chunk size and slice
// into a rows × columns grid. Each chunk goes to Gemini at full resolution.
//
// TARGET_CHUNK_WIDTH/HEIGHT are tuned so the grid computed by ceil(W/target)
// aligns with ShareSansar's actual stitched page layout, NOT just any A4 size.
// Empirical: Salt Trading Q3 image is 7650×7016 with PDF pages laid out as
// 3 cols × 2 rows = 6 pages. ceil(7650/2700)=3, ceil(7016/4000)=2 → 3×2 grid
// matches the actual page boundaries, avoiding mid-page cuts that fragmented
// the table content when we used a 4×2 grid (TARGET_CHUNK_WIDTH=2500).
//
// For single-page A4 portraits (2480×3508) and similar smaller layouts,
// ceil(W/2700)=1 and ceil(H/4000)=1, so no split happens — exactly what
// we want for the non-Financial-Analysis common case.
// ─── WIDTH SLACK (2026-08-03) ───
// The COLUMN count uses TARGET_CHUNK_WIDTH * WIDTH_SLACK; the ROW count does
// NOT. Reason, from the real corpus (~858 logged image events):
//
//   MAHULI LAGHUBITTA 4th-quarter notice = 2911×4254. ceil(2911/2700) = 2, so a
//   SINGLE A4-ish sheet only 7.8% wider than the target was cut straight down
//   the middle at x=1456. That cut bisected the masthead — OCR returned only
//   the right-hand remnant "TA BITTIYA SANSTHA LIMITED", which became the
//   posted article's <h2> — and fell INSIDE the right-hand table, orphaning
//   "13,181,172.38" onto its own line so detectFinancialTables could no longer
//   rebuild the <tr>. The bug is the TRIGGER, not just the cut position.
//
// A 3105px threshold collapses the whole 2835-2914 width cluster (14 of 858
// logged events, Mahuli included) to a single column and leaves 3508,
// 3876-3900, 4100, 5100-5311, 6633 and 6802 splitting exactly as today.
// Safe window is 2914 < T <= 3508; 3105 sits in the middle.
//
// DO NOT apply the same slack to HEIGHT. A 4600px row threshold would collapse
// the 4016-4490 height cluster (~15 real events, mostly 1420px-wide sheets)
// into single whole-image calls at ~0.68x downscale — the exact Devanagari
// digit-smearing failure this splitter exists to prevent. Width only.
const TARGET_CHUNK_WIDTH = 2700;
const TARGET_CHUNK_HEIGHT = 4000;
const WIDTH_SLACK = 1.15;
const COL_SPLIT_THRESHOLD = Math.round(TARGET_CHUNK_WIDTH * WIDTH_SLACK); // 3105
const MAX_CHUNKS = 12;  // safety ceiling — refuse anything sillier (12 = 4×3 grid)

async function splitImageIntoGrid(imageBuffer, mediaType, indexLabel) {
  try {
    const meta = await sharp(imageBuffer).metadata();
    if (!meta.width || !meta.height) return [imageBuffer];

    const aspect = meta.height / meta.width;
    // Column threshold carries WIDTH_SLACK so a single sheet marginally wider
    // than the target is never cut down the middle (see WIDTH_SLACK above).
    const cols = Math.max(1, Math.ceil(meta.width / COL_SPLIT_THRESHOLD));
    const rows = Math.max(1, Math.ceil(meta.height / TARGET_CHUNK_HEIGHT));
    const totalCells = cols * rows;

    // Always log dimensions + computed grid so the operator can see what
    // happened. Examples:
    //   "image 2480×3508 aspect 1.41 — single chunk (no grid split needed)"
    //   "image 1200×4800 aspect 4.00 — splitting into 1×2 grid (2 cells)"
    //   "image 7650×7016 aspect 0.92 — splitting into 4×2 grid (8 cells)"
    process.stdout.write(
      `      ${indexLabel || "[--]"} image ${meta.width}×${meta.height} aspect ${aspect.toFixed(2)}`
    );

    if (totalCells === 1) {
      process.stdout.write(` — single chunk (no grid split needed)\n`);
      return [imageBuffer];
    }

    if (totalCells > MAX_CHUNKS) {
      process.stdout.write(
        ` — grid ${cols}×${rows}=${totalCells} exceeds ${MAX_CHUNKS} cap, OCR'ing whole image\n`
      );
      return [imageBuffer];
    }

    process.stdout.write(` — splitting into ${cols}×${rows} grid (${totalCells} cells)\n`);

    const cellWidth = Math.ceil(meta.width / cols);
    const cellHeight = Math.ceil(meta.height / rows);
    const chunks = [];

    // Read order: top-to-bottom, then left-to-right within each row. This
    // matches the natural reading flow of a stitched multi-page PDF where
    // pages run row-by-row across the grid. Wrong order produces a body
    // with pages interleaved out of sequence.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const left = c * cellWidth;
        const top = r * cellHeight;
        const width = Math.min(cellWidth, meta.width - left);
        const height = Math.min(cellHeight, meta.height - top);
        if (width <= 0 || height <= 0) continue;
        // Sharp's extract is non-mutating; we get a fresh buffer per chunk.
        // Convert to JPEG quality 95 — keeps file size sane while preserving
        // small-text legibility (Gemini accepts both PNG and JPEG inline).
        const chunkBuf = await sharp(imageBuffer)
          .extract({ left, top, width, height })
          .jpeg({ quality: 95 })
          .toBuffer();
        chunks.push(chunkBuf);
      }
    }
    return chunks;
  } catch (err) {
    // If sharp fails (corrupt image, unsupported format, etc.), fall back
    // to OCR'ing the whole image as-is rather than failing the notice.
    process.stderr.write(
      `      [image-split] sharp error (${err.message}), OCR'ing whole image\n`
    );
    return [imageBuffer];
  }
}

// Per-chunk OCR — does the actual single API call. Returns the parsed
// {content, shortTitleNp, shortTitleEn} or throws on hard failure. This
// is the body that used to be in ocrViaGemini before the split wrapper
// was added.
async function ocrSingleImageViaGemini(imageBuffer, indexLabel, mediaType, model) {
  // Outer loop = "key attempts". Inner loop = "retries on transient errors
  // for the current key." When the inner loop fails out with a 429 AND
  // we have backup keys, we rotate and the outer loop tries again.
  while (true) {
    const result = await ocrSingleImageViaGeminiWithCurrentKey(
      imageBuffer,
      indexLabel,
      mediaType,
      model
    );
    if (!result.exhausted429) return result.value;
    // Current key exhausted (429 + retries failed). Try the next key.
    if (!rotateGeminiKey()) {
      // No more backups. Surface the original 429 error.
      throw result.error;
    }
    // Loop with the new active key.
  }
}

// Inner OCR routine — runs ONE round of (initial attempt + transient retries)
// against the currently-active key. Returns either:
//   { exhausted429: false, value: {...} }   ← success
//   { exhausted429: true,  error: <err> }   ← key burned out, rotate
// Anything else (non-transient HTTP error, no-text, etc.) throws.
async function ocrSingleImageViaGeminiWithCurrentKey(imageBuffer, indexLabel, mediaType, model) {
  const key = getGeminiKey();
  if (!key) {
    throw new Error(
      "Gemini API key not found. Create " +
        path.join(__dirname, ".gemini-key") +
        " containing your AIza... key from https://aistudio.google.com/apikey,\n" +
        "or .gemini-keys (one per line) for backup keys with auto-rotation."
    );
  }
  const base64 = imageBuffer.toString("base64");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    systemInstruction: { parts: [{ text: GEMINI_OCR_SYSTEM_PROMPT }] },
    contents: [
      {
        parts: [
          { inline_data: { mime_type: mediaType, data: base64 } },
          {
            text: "Extract the text from this ShareSansar notice image, following the rules in the system prompt.",
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      // Was 8192 — that capped out on multi-page notices (Salt Trading Q3
      // hit MAX_TOKENS mid-content, returning an unparseable JSON fragment).
      // gemini-2.5-flash supports up to 65,535 output tokens; 32K gives a
      // generous safety margin for even the longest stitched multi-page
      // notices without paying for tokens we won't use.
      maxOutputTokens: 32768,
      // 2026-09-04: gemini-2.5-flash reasons before answering, and those
      // THINKING tokens are charged against maxOutputTokens. On the Sanima Bank
      // 22nd AGM notice the budget ran out partway through: the Nepali half came
      // back (3882 chars), the English half was empty, and the article published
      // with a blank English tab. Transcription gains nothing from reasoning —
      // measured on the same image, thinking on vs off gave byte-identical output
      // in 34.0s vs 8.0s. With it off the whole budget goes to content.
      thinkingConfig: { thinkingBudget: 0 },
      response_mime_type: "application/json",
    },
  };

  process.stdout.write(`      ${indexLabel} OCR via Gemini (${model})...`);
  const t0 = Date.now();

  // Initial attempt + up to 3 retries on transient 5xx/429. Permanent
  // errors (400 bad request, 401/403 bad key) fail fast on the first try.
  let lastErr = null;
  for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const wait = GEMINI_RETRY_DELAYS_MS[attempt - 1];
      process.stdout.write(` retry ${attempt} in ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
    }

    let res;
    try {
      res = await callGeminiOnce(url, body);
    } catch (netErr) {
      // Network error — treat like a transient and continue to next attempt.
      lastErr = netErr;
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const candidate = data?.candidates?.[0];
      const finishReason = candidate?.finishReason;
      const text = candidate?.content?.parts?.find(
        (p) => typeof p.text === "string"
      )?.text;

      if (!text) {
        const reason =
          finishReason || data?.promptFeedback?.blockReason || "unknown";
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(` no text (${reason}) ${dt}s\n`);
        throw new Error(
          `Gemini returned no text (finishReason=${reason}). Response head: ${JSON.stringify(data).substring(0, 500)}`
        );
      }

      // Response is JSON per the system prompt — but Gemini sometimes wraps
      // it in markdown code fences ("```json ... ```") or prefixes with a
      // preamble despite explicit instructions. tryParseGeminiJson handles
      // those variants AND brace-less truncated responses (see its tier-4/5
      // recovery paths) before giving up.
      const parsed = tryParseGeminiJson(text);

      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      // finishReason === "MAX_TOKENS" → response truncated mid-stream; warn
      // so the operator knows the JSON.content is incomplete even if the
      // recovery parser salvaged something usable.
      const reasonHint =
        finishReason && finishReason !== "STOP" ? ` [${finishReason}]` : "";

      if (parsed && typeof parsed === "object" && typeof parsed.content === "string") {
        const contentEn = typeof parsed.content_en === "string" ? parsed.content_en : "";
        process.stdout.write(
          ` ${dt}s, ${parsed.content.length} np / ${contentEn.length} en chars${reasonHint}\n`
        );
        return {
          exhausted429: false,
          value: {
            content: parsed.content,
            contentEn,
            shortTitleNp: typeof parsed.short_title_np === "string" ? parsed.short_title_np.trim() : "",
            shortTitleEn: typeof parsed.short_title_en === "string" ? parsed.short_title_en.trim() : "",
          },
        };
      }
      // Fallback — no structured JSON parsed even after all recovery tiers.
      // Dump the raw response to a debug file so the operator can inspect
      // what Gemini actually returned (essential for diagnosing pipeline
      // breakage; the previous version silently swallowed the raw text).
      const debugFile = path.join(__dirname, "last-gemini-failure.txt");
      try {
        fs.writeFileSync(
          debugFile,
          `finishReason=${finishReason}\n` +
            `length=${text.length}\n` +
            `index=${indexLabel}\n` +
            "----- raw response below -----\n" +
            text,
          "utf-8"
        );
      } catch {}
      process.stdout.write(
        ` ${dt}s, ${text.length} chars (no JSON parse)${reasonHint} → ${path.basename(debugFile)}\n`
      );
      return {
        exhausted429: false,
        value: { content: text, contentEn: "", shortTitleNp: "", shortTitleEn: "" },
      };
    }

    // Non-OK response: decide whether to retry.
    const errText = await res.text().catch(() => "");
    lastErr = new Error(
      `Gemini ${res.status}: ${errText.replace(/\s+/g, " ").substring(0, 400)}`
    );
    lastErr.status = res.status;

    if (!isTransientGeminiStatus(res.status)) {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(` FAILED (${res.status}) ${dt}s\n`);
      throw lastErr;
    }
    // Else: loop will sleep + retry
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(` FAILED after retries ${dt}s\n`);
  // If the terminal failure was a 429, signal to the outer wrapper that
  // this key is burned and we should rotate to a backup before giving up.
  if (lastErr && lastErr.status === 429) {
    return { exhausted429: true, error: lastErr };
  }
  throw lastErr || new Error("Gemini OCR: exhausted retries with no specific error");
}

// ─── ocrViaGemini ─ public wrapper ───
//
// Handles the full OCR flow for one notice image:
//   1. Pick the model based on category (Financial Analysis can route to
//      a higher-accuracy model if HIGH_ACCURACY_CATEGORIES is populated;
//      otherwise default to flash).
//   2. Split tall stitched multi-page images into per-page chunks so
//      Gemini doesn't downscale them into illegibility (see splitImageIfTall).
//   3. OCR each chunk sequentially (parallel runs risk free-tier rate limits;
//      sequential keeps memory + quota predictable).
//   4. Concatenate per-chunk `content` strings with a blank-line separator
//      so structureToHtml's paragraph splitter handles the page boundary
//      cleanly. Headline (short_title_*) comes from the FIRST chunk only —
//      the cover page is where the notice's purpose lives.
//   5. If a chunk fails, log it but continue with the rest. Only throw if
//      ALL chunks fail (we'd have no content to publish).
// Title repair. A chunk may read a heading only PARTIALLY when a seam clips it
// (the pre-fix Mahuli <h2> was "TA BITTIYA SANSTHA LIMITED", the right-hand
// remnant of "MAHULI LAGHUBITTA BITTIYA SANSTHA LIMITED"). Accept a LONGER
// candidate only when it literally CONTAINS the one we already have, so a
// genuine completion wins and two unrelated page headings are never merged.
// Cannot touch digits — it only ever swaps one title string for a superstring.
function pickBestTitle(current, candidate) {
  const cand = (candidate || "").trim();
  if (!cand) return current;
  const cur = (current || "").trim();
  if (!cur) return cand;
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const nc = norm(cur), nk = norm(cand);
  if (nk.length > nc.length && nk.includes(nc)) return cand;
  return cur;
}

async function ocrViaGemini(imageBuffer, indexLabel, mediaType, category) {
  const model = getGeminiModelForCategory(category);

  // Chunks are JPEGs after splitting, so the per-chunk mime type changes.
  // The original mediaType is only used when the image wasn't split.
  const chunks = await splitImageIntoGrid(imageBuffer, mediaType, indexLabel);

  if (chunks.length === 1) {
    // Single image — straight call, unchanged behaviour.
    return ocrSingleImageViaGemini(chunks[0], indexLabel, mediaType, model);
  }

  // Multi-chunk path — log the split so the operator can see what's
  // happening on long notices.
  process.stdout.write(
    `      ${indexLabel} tall image split into ${chunks.length} chunks\n`
  );

  const contentsNp = [];
  const contentsEn = [];
  let firstTitleNp = "";
  let firstTitleEn = "";
  let successCount = 0;
  let lastErr = null;

  // Per-chunk inter-call delay — Google AI Studio free tier on
  // gemini-2.5-flash is ~10 requests/minute. Firing all chunks back-to-back
  // burns the per-minute quota and the retry backoffs (3s/8s/20s) aren't
  // long enough to reset it. 6500ms between chunks keeps us comfortably
  // under 10 RPM (= 6s/request minimum), with a small safety margin.
  const INTER_CHUNK_DELAY_MS = 6500;

  for (let i = 0; i < chunks.length; i++) {
    const chunkLabel = `${indexLabel} chunk ${i + 1}/${chunks.length}`;
    if (i > 0) {
      await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
    }
    try {
      const result = await ocrSingleImageViaGemini(
        chunks[i],
        chunkLabel,
        "image/jpeg",
        model
      );
      if (result.content) contentsNp.push(result.content);
      if (result.contentEn) contentsEn.push(result.contentEn);
      // Keep the first non-empty title we see — usually from chunk 1 (cover
      // page) but if Gemini didn't generate one there, try later chunks.
      // Was "first non-empty wins", which locks in a chunk's TRUNCATED reading
      // of a clipped heading. pickBestTitle upgrades only to a superstring, so
      // a later chunk that saw the whole masthead repairs it and an unrelated
      // page heading can never overwrite it.
      firstTitleNp = pickBestTitle(firstTitleNp, result.shortTitleNp);
      firstTitleEn = pickBestTitle(firstTitleEn, result.shortTitleEn);
      successCount++;
    } catch (e) {
      lastErr = e;
      process.stderr.write(
        `      ${chunkLabel} FAILED (${e.message}) — continuing with remaining chunks\n`
      );
    }
  }

  if (successCount === 0) {
    throw lastErr || new Error(`All ${chunks.length} OCR chunks failed`);
  }

  return {
    content: contentsNp.join("\n\n"),  // Nepali content (blank line separates page boundaries)
    contentEn: contentsEn.join("\n\n"),  // English translation (same structure)
    shortTitleNp: firstTitleNp,
    shortTitleEn: firstTitleEn,
  };
}

// ─── OCR cleanup ───
//
// Letterhead strategy: companies always put contact info AFTER the name and
// address block (e.g. "Dordi Khola Jal Bidyut Company Limited" / "Bluestar
// Complex, Tripureshwor-11" / "Phone: 01-5332749"). Iterative "peel matching
// lines from the top" doesn't work because the name/address lines don't
// themselves match a noise pattern.
//
// Instead: scan the first LETTERHEAD_SCAN_LINES lines for a hard end-marker
// (Phone/Fax/Email/Tel/Mobile/Web/P.O.Box) and drop everything UP TO AND
// INCLUDING that line.
const LETTERHEAD_SCAN_LINES = 10;
const LETTERHEAD_END_MARKERS = [
  // Contact-info line starts — colon/dash optional because OCR may drop them.
  /^(phone|fax|email|e-mail|tel|tel\.|mobile|mob\.|web|website|url)\b/i,
  // Email-like @domain anywhere in the line.
  /[@][a-z0-9.-]+\.[a-z]{2,}/i,
  // "www.something.com" anywhere (catches OCR'd website lines without "Website:" prefix).
  /\bwww\.[a-z0-9.-]+\.[a-z]{2,}/i,
  /^p\.?\s*o\.?\s*box\b/i,
  /^(post\s*box|gpo|g\.p\.o)\b/i,
  // Common subsidiary/affiliate footer phrase.
  /\b(wholly\s+owned\s+subsidiary|subsidiary\s+of)\b/i,
];

// Global noise — applied anywhere in the text, not just at the tail. These
// English footnote markers can land mid-document on bilingual notices, after
// the English data block but before the Nepali narrative.
const GLOBAL_NOISE_PATTERNS = [
  /^[\*•·\-–—]+\s*$/,
  /^[\*•]+\s*previous\s+year/i,
  /^[\*•]+\s*figures?\s+(of|are)/i,
];

// Minimum char count we expect a real notice to produce after cleaning.
// If a non-empty input gets filtered below this, our filters were too
// aggressive and we restore the original (uncleaned) text rather than
// publish an empty body. Observed failure: Himalayan Bank "promoter share
// conversion" notice — 1592 raw chars wiped to 0 because the body landed
// entirely between aggressive leading + trailing letterhead trims.
const MIN_USEFUL_CLEANED_LENGTH = 80;

function cleanOcrText(rawText) {
  // Safety net: if input is empty/whitespace, nothing to clean — return as-is.
  const rawTrimmed = (rawText || "").trim();
  if (!rawTrimmed) return "";

  let lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  // 1a) Leading letterhead drop — look for an end-marker in the first N lines
  //     and drop everything up to and including the LAST such marker (companies
  //     stack name → address → phone → email; we want to drop the whole block).
  const leadingScanLimit = Math.min(lines.length, LETTERHEAD_SCAN_LINES);
  let letterheadEnd = -1;
  for (let i = 0; i < leadingScanLimit; i++) {
    if (LETTERHEAD_END_MARKERS.some((re) => re.test(lines[i]))) {
      letterheadEnd = i;
    }
  }
  if (letterheadEnd >= 0) {
    lines = lines.slice(letterheadEnd + 1);
  }

  // 1b) Trailing letterhead drop — symmetric to the leading filter. Many
  //     announcements end with the issue manager's contact block (Phone:/
  //     Email:/Website: lines + logo OCR debris). Scan the LAST N lines for
  //     the FIRST marker hit and drop from there to the end.
  //
  //     IMPORTANT: if there's not much body left after the leading trim
  //     (i.e. the whole notice was short), skip this filter — otherwise we
  //     risk wiping the entire body when the leading + trailing zones
  //     overlap or sandwich the actual content. The MIN_USEFUL_CLEANED_LENGTH
  //     safety net below catches the same case at the END of cleaning, but
  //     skipping here keeps the recovery path simpler.
  if (lines.join("\n").length > MIN_USEFUL_CLEANED_LENGTH) {
    const trailingStart = Math.max(0, lines.length - LETTERHEAD_SCAN_LINES);
    let trailingLetterheadStart = -1;
    for (let i = trailingStart; i < lines.length; i++) {
      if (LETTERHEAD_END_MARKERS.some((re) => re.test(lines[i]))) {
        trailingLetterheadStart = i;
        break;
      }
    }
    if (trailingLetterheadStart >= 0) {
      lines = lines.slice(0, trailingLetterheadStart);
    }
  }

  // 2) Global noise drop — remove footnote markers wherever they appear
  lines = lines.filter((line) => !GLOBAL_NOISE_PATTERNS.some((re) => re.test(line)));

  // 3) Per-line artifact scrubbing
  lines = lines
    .map((line) =>
      line
        .replace(/~~/g, "")
        .replace(/c=\]/g, "")
        .replace(/^[|]+\s*/, "")             // strip leading pipe(s) glued to first word
        .replace(/(^|\s)\|(\s|$)/g, " ")     // strip isolated pipes
        .replace(/\[\s*\]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim()
    )
    .filter((l) => l.length > 1); // drop single-char debris lines anywhere

  const cleaned = lines.join("\n");

  // 4) FINAL SAFETY NET — if cleaning wiped the content below the useful
  //    threshold (despite the input having real text), fall back to the
  //    raw input. Better to publish a notice with some letterhead noise at
  //    the top/bottom than to publish an empty body.
  if (cleaned.length < MIN_USEFUL_CLEANED_LENGTH && rawTrimmed.length >= MIN_USEFUL_CLEANED_LENGTH) {
    process.stderr.write(
      `      [cleanOcrText] filters wiped input below ${MIN_USEFUL_CLEANED_LENGTH} chars ` +
        `(raw=${rawTrimmed.length}, cleaned=${cleaned.length}) — falling back to raw\n`
    );
    return rawTrimmed;
  }

  return cleaned;
}

// ─── Structural HTML emission (Tier 2) ───
//
// Turns flat OCR lines into semantic HTML so the news article page's `prose`
// styles produce a real document layout instead of one-paragraph-per-line.
//
// Detection rules (conservative — anything ambiguous falls back to <p>):
//   <h2>        : line is all-caps Latin (no Devanagari, no lowercase)
//                 length 10-120, allows digits/space/parens/commas/hyphens
//                 e.g. "UNAUDITED FINANCIAL STATEMENTS"
//   <h3>        : line starts with a digit (Nepali or Latin) + . / । / :
//                 + Devanagari content. e.g. "१. वित्तीय विवरण"
//                 OCR often misreads Nepali ८ as Latin 8 — both accepted.
//   <strong>X)</strong> ...
//               : line starts with a single Devanagari consonant + ) + space.
//                 e.g. "क) आ.व. २०८२/८३..." — the "क)" gets bolded inline,
//                 the rest joins the paragraph. Subsequent non-heading lines
//                 belong to the same subsection paragraph.
//   <em>...</em>: line starts with "* " — kept as italicized footnote.
//   <p>         : everything else, INCLUDING any line that looksLikeDataRowLine()
//                 flags as a financial data row and any line that
//                 isTableHeaderRowLine() flags as a column-label row.
//                 EXACTLY ONE block per line — detectFinancialTables splits on
//                 "\n" and depends on that contract. There is no line-joining
//                 code (the old claim here was false); never re-introduce it, it
//                 would merge data rows into one paragraph and destroy every table.

function isEnglishCapsHeading(line) {
  if (line.length < 10 || line.length > 120) return false;
  if (/[ऀ-ॿ]/.test(line)) return false; // any Devanagari -> not English heading
  if (/[a-z]/.test(line)) return false;            // any lowercase -> not heading
  if (!/[A-Z]/.test(line)) return false;           // must contain at least one cap
  return /^[A-Z0-9 \-&(),.\/:]+$/.test(line);
}

function isNumberedSection(line) {
  // Nepali digits ०-९ OR Latin 0-9 (OCR misreads), then . / । / :, then Devanagari
  return /^(?:[०-९]+|\d+)\s*[.।:]\s+[ऀ-ॿ]/.test(line);
}

// English-language numbered sections — e.g. "1. Financial Statement: ...".
// Common on bilingual notices where the Nepali section list also has a
// matching English version. Conservative: requires a Latin digit + period
// + Capitalized first word, AND a colon somewhere (the typical
// section-heading marker), OR the line is short enough to be a bare title.
function isEnglishNumberedSection(line) {
  if (!/^\d+\.\s+[A-Z]/.test(line)) return false;
  if (/[ऀ-ॿ]/.test(line)) return false; // mixed-script lines are handled by Devanagari rule
  if (/:/.test(line)) return true;       // has colon → heading marker
  if (line.length < 80) return true;     // short capitalized line → likely heading
  return false;
}

function isLetteredSubsectionMatch(line) {
  // Single Devanagari consonant (क-ज is enough for क/ख/ग/घ/ङ/च/छ/ज) + ) + text
  return line.match(/^([क-ज])\)\s*(.+)$/);
}

function isFootnoteLine(line) {
  return /^\*\s+\S/.test(line);
}

// Strip a leading numbered-list marker so <ol><li> renders cleanly without
// duplicating the visible number. Handles both Nepali (१. २. ३.) and Latin
// (1. 2. 3.) prefixes with the standard separators . / । / :.
function stripNumberedPrefix(line) {
  return line.replace(/^(?:[०-९]+|\d+)\s*[.।:]\s+/, "");
}

// Centered subheading detection — STRICT whitelist only. The previous
// "any Devanagari line < 28 chars" rule produced massive false positives
// on quarterly reports: date stamps, addressees, signatures, balance-sheet
// sub-labels, and short ratio lines all got rendered as centered <h3>s,
// producing a body riddled with random oversized headings. Now we only
// flag lines that match one of three explicit patterns:
//   1. Title-ending markers: "...सूचना", "...बारेमा", "...घोषणा"
//   2. Recognised standalone section words (तपसिल, शर्तहरु, बोधार्थ, etc.)
//   3. Multi-word financial-statement headings (नाफा नोक्सान विवरण, etc.)
// Anything else stays as a plain <p>. False negatives (real centered
// headings we miss) just look like body paragraphs — visually safe.
// False positives — the previous failure mode — look like document chrome
// vandalism, so we err strongly toward false negatives.
const CENTERED_HEADING_WHITELIST = new Set([
  "तपसिल",        // schedule / annex
  "शर्तहरु",      // terms
  "बोधार्थ",      // cc:
  "भवदीय",        // yours sincerely
  "वासलात",       // balance sheet
  "अनुसूची",      // annex
  "विषयसूची",     // table of contents
]);
function isCenteredSubheading(line) {
  if (!line) return false;
  // Reject any line with Latin digits OR Devanagari digits — data rows
  // (e.g. "मूल्य आम्दानी अनुपात १५८।०४") are NOT headings, even if short.
  if (/[A-Za-z0-9०-९]/.test(line)) return false;
  // Require Devanagari content (script range U+0900..U+097F).
  if (!/[ऀ-ॿ]/.test(line)) return false;
  const trimmed = line.replace(/\s+/g, " ").trim();

  // (1) Title-ending markers. e.g. "खुल्ला बोलकबोल सम्बन्धी सूचना"
  if (/(सूचना|बारेमा|घोषणा)\s*[।.!?]?$/.test(trimmed)) return true;

  // Strip trailing punctuation (danda, period, etc.) for whitelist lookup.
  const stripped = trimmed.replace(/[।.!?\s]+$/, "");

  // (2) Recognised standalone section words.
  if (CENTERED_HEADING_WHITELIST.has(stripped)) return true;

  // (3) Multi-word financial-statement headings.
  if (/^नाफा\s*नोक्सान\s*(सम्बन्धी\s*)?विवरण$/.test(stripped)) return true;
  if (/^नगद\s*प्रवाह\s*(सम्बन्धी\s*)?विवरण$/.test(stripped)) return true;

  return false;
}

function classifyLine(line) {
  // Explicit author marker wins outright. Hoisted above the data-row guard so a
  // footnote sentence that happens to end in two figures is never tabled.
  // Behaviour-preserving: /^\*\s+\S/ is disjoint from every rule below it.
  if (isFootnoteLine(line)) return "footnote";

  // 2026-07-30 ROOT-CAUSE FIX — a financial DATA ROW outranks every
  // heading/list rule. isNumberedSection matches
  //   "१. बैंक मौज्दात २२२,०७६,९९०.८२ १०२,३१७,५३३.८२"
  // and the run-length switch in structureToHtml then emitted <h3> (run 1-2) or
  // <ol><li> (run 3+, serial DELETED by stripNumberedPrefix) — both shapes
  // invisible to detectFinancialTables' <p> gate, so every serial-led statement
  // row rendered as prose (post 5520 Machhapuchchhre SIP Yojana). Must sit
  // ABOVE isEnglishCapsHeading too: "TOTAL 294,290,383.70 310,708,779.60"
  // satisfies that charset and would become a centered <h2> in english_content,
  // splitting the table.
  if (looksLikeDataRowLine(line)) return "para";

  // Column-label rows must reach detectFinancialTables as a plain <p> so they
  // can be promoted to <thead>. Above isEnglishCapsHeading because
  // "S.N. PARTICULARS AMOUNT (RS.)" is ALL-CAPS Latin.
  if (isTableHeaderRowLine(line)) return "para";

  if (isEnglishCapsHeading(line)) return "h2";
  if (isNumberedSection(line) || isEnglishNumberedSection(line)) return "numbered";
  if (isLetteredSubsectionMatch(line)) return "sub";
  if (isCenteredSubheading(line)) return "centered-heading";
  return "para";
}

// Threshold for "consecutive numbered lines → ordered list" vs.
// "isolated numbered line → section heading". Quarterly reports use
// numbered <h3> headings interleaved with body paragraphs, so single
// numbered lines stay as headings. Bank-branch lists / AGM agendas
// have many numbered items in a row, so 3+ consecutive get grouped.
const NUMBERED_RUN_LIST_THRESHOLD = 3;

function structureToHtml(cleanedText) {
  const lines = cleanedText
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1);

  // Pre-classify each line so we can do run-length detection for numbered lists.
  const classified = lines.map((line) => ({ line, kind: classifyLine(line) }));

  const out = [];
  let i = 0;
  while (i < classified.length) {
    const current = classified[i];

    // Numbered lines: look ahead for a run. If 3+ consecutive numbered
    // lines, render as <ol><li>. Otherwise treat each as a section <h3>.
    if (current.kind === "numbered") {
      let j = i;
      const runTexts = [];
      while (j < classified.length && classified[j].kind === "numbered") {
        runTexts.push(classified[j].line);
        j++;
      }

      if (runTexts.length >= NUMBERED_RUN_LIST_THRESHOLD) {
        out.push("<ol>");
        for (const text of runTexts) {
          out.push(`<li>${escapeHtml(stripNumberedPrefix(text))}</li>`);
        }
        out.push("</ol>");
      } else {
        for (const text of runTexts) {
          out.push(`<h3>${escapeHtml(text)}</h3>`);
        }
      }
      i = j;
      continue;
    }

    if (current.kind === "h2") {
      out.push(`<h2 style="text-align:center">${escapeHtml(current.line)}</h2>`);
    } else if (current.kind === "centered-heading") {
      // Centered subheading — preserve the source notice's visual emphasis
      // on lines like "तपसिल", "शर्तहरु", or the notice's own top title.
      out.push(
        `<h3 style="text-align:center">${escapeHtml(current.line)}</h3>`
      );
    } else if (current.kind === "sub") {
      const m = isLetteredSubsectionMatch(current.line);
      out.push(
        `<p><strong>${escapeHtml(m[1])})</strong> ${escapeHtml(m[2])}</p>`
      );
    } else if (current.kind === "footnote") {
      out.push(`<p><em>${escapeHtml(current.line)}</em></p>`);
    } else {
      out.push(`<p>${escapeHtml(current.line)}</p>`);
    }
    i++;
  }

  return out.join("\n");
}

function deriveSummary(cleanedText, maxLen = 200) {
  const t = cleanedText.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  const cut = t.substring(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  return (sp > 60 ? cut.substring(0, sp) : cut) + "...";
}

// ShareSansar's <div id="newsdetail-content"> on announcement pages usually
// just repeats the H1. If the summary is essentially the title, drop it so
// we don't publish a useless duplicate.
function looksLikeTitleDuplicate(summary, title) {
  const norm = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
  const a = norm(summary);
  const b = norm(title);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

// ─── Financial table detection (Tier 3) ───
//
// After structureToHtml emits one HTML block per line, scan the sequence for
// runs of 2+ consecutive <p> blocks that LOOK LIKE table rows (label + 2+
// numeric columns), and re-emit those runs as a single <table>. Runs of less
// than 2 stay as plain <p>.
//
// Cell-matching supports BOTH Latin (0-9) AND Devanagari (०-९) digits — the
// previous regex was Latin-only, which silently failed on every NEPSE
// quarterly report (Devanagari numerals are the norm in those filings).
//
// For 2-cell rows (NEPSE balance sheets are typically 2-column: current
// quarter vs. prior-year same quarter) we require BOTH cells to look
// "financial" — i.e. comma-separated thousands, decimal point, or 5+
// consecutive digits. This rejects body sentences that incidentally mention
// two small numbers (e.g. "८० मध्ये २०" → bare digits, not financial).

// Match a numeric "cell" — supports Devanagari (०-९) + Latin (0-9) digits,
// comma-separated thousands, decimals, parenthesized negatives (financial
// convention), and the Devanagari danda separator "।" used in some legacy
// notices (e.g. "रु. १५८।०४" instead of "१५८.०४").
const TABLE_CELL_RE = /(?:^|\s)(\(?-?[\d०-९][\d०-९,]*(?:[.।][\d०-९]+)?\)?)(?=\s|$|।)/g;

// True if a cell value looks like a real financial number (not just a count).
// Used to filter false positives on 2-cell rows.
function isFinancialNumeric(value) {
  if (/[,.]/.test(value)) return true;             // has thousands separator or decimal
  const digits = value.replace(/[^\d०-९]/g, "");
  return digits.length >= 5;                       // long bare number (e.g. shareholding)
}

// A "serial cell" is the tiny row index that leads NEPSE statement rows
// ("१ सूचीकृत शेयर १,२२३,००७ १,१२३,७६८"). Short bare integer (1-3 digits), no
// comma/decimal. We keep it inside the label rather than rejecting the whole
// row as a numbered-list item (which is what stranded every serial-numbered
// balance-sheet row as a flat <p> — Garima Samriddhi Yojana, 2026-07-03).
function isSerialCell(value) {
  if (/[,.।]/.test(value)) return false;
  const digits = value.replace(/[^\d०-९]/g, "");
  return digits.length >= 1 && digits.length <= 3;
}

function findNumericCells(text) {
  TABLE_CELL_RE.lastIndex = 0;
  const cells = [];
  let m;
  while ((m = TABLE_CELL_RE.exec(text)) !== null) {
    // m[1] is the captured cell; m.index is start of the match (including
    // the leading space). Compute the cell's own start index.
    const cellStart = m.index + (m[0].length - m[1].length);
    cells.push({ value: m[1], start: cellStart, end: cellStart + m[1].length });
  }
  return cells;
}

// ── Row cells = numeric cells + explicit empty-cell placeholders ──
// The OCR prompt (section F) instructs Gemini to write "-" for an empty cell
// "to preserve column alignment", but TABLE_CELL_RE matches digits only, so
// those placeholders were INVISIBLE: every value after a blank column silently
// shifted one column left and was attributed to the WRONG period. A standalone
// dash surrounded by whitespace is a real cell. (A signed value "-५००" is
// unaffected — the lookahead requires whitespace/end right after the dash, and
// TABLE_CELL_RE already captures the sign itself.)
const DASH_CELL_RE = /(?:^|\s)([-–—])(?=\s|$)/g;

// Devanagari LETTERS only — U+0900..U+097F minus the digit block U+0966..U+096F.
// Using the full `[ऀ-ॿ]` range here is a trap: it also matches २२२, so a
// "no letters in the value region" test would reject every Nepali data row
// (caught by --classify-test on the post-5520 fixture, 2026-07-30).
const LETTER_RE = /[A-Za-zऀ-॥॰-ॿ]/;

function findCells(text) {
  const cells = findNumericCells(text).map((c) => ({ ...c, kind: "num" }));
  DASH_CELL_RE.lastIndex = 0;
  let m;
  while ((m = DASH_CELL_RE.exec(text)) !== null) {
    const start = m.index + (m[0].length - m[1].length);
    cells.push({ value: m[1], start, end: start + m[1].length, kind: "dash" });
  }
  cells.sort((a, b) => a.start - b.start);
  return cells;
}

// Single source of truth for the leading-serial fold, so validation
// (looksLikeDataRowText) and emission (tableRowFromText) can never disagree.
// `reject` = the line opens with a number that is NOT a serial, i.e. a real
// numbered list item ("1. ...").
function splitSerial(cells) {
  if (cells.length === 0) return { dataCells: [], reject: true };
  const first = cells[0];
  if (first.start < 3) {
    if (first.kind === "num" && isSerialCell(first.value) && cells.length >= 3) {
      return { dataCells: cells.slice(1), reject: false };   // serial stays in the label
    }
    return { dataCells: cells, reject: true };
  }
  return { dataCells: cells, reject: false };
}

// Tag-agnostic core of the data-row test. Split out of looksLikeTableRow so
// classifyLine can consult it BEFORE the heading/list rules steal the line
// (2026-07-30: isNumberedSection was turning every serial-led statement row
// into <h3>/<ol><li>, shapes the <p>-only gate below then refused to inspect —
// post 5520 "Machhapuchchhre SIP Yojana" had 4 fragment tables + stranded rows).
function looksLikeDataRowText(text) {
  if (!text) return false;
  const cells = findCells(text);
  if (cells.length < 2) return false;                    // need 2+ columns
  const { dataCells, reject } = splitSerial(cells);
  if (reject) return false;                              // real numbered list ("1. ...")
  if (dataCells.length < 2) return false;                // need 2+ data columns
  const numData = dataCells.filter((c) => c.kind === "num");

  // ── D2 ── An ALL-DASH row ("२. बैंक मुद्दती निक्षेप - -") is a genuine
  // statement row whose every period column was blank in the source, so the OCR
  // wrote the "-" placeholder in each one. Rejecting it here is what let
  // isBridgeLabelLoose claim it (serial-stripped: 5 words, no digits, no parens)
  // and render it as a full-width emerald section BAND in the middle of a table
  // — post 5571 "NIBL Sahabhagita Fund". It carries no figure, so no numeric
  // evidence can vouch for it; demand the strongest SHAPE evidence instead: 2+
  // data cells, EVERY one a dash, and a real lettered label in front. The "no
  // letters after the first data cell" guard below then still kills
  // "क) शेयर - बोनस - अधिकार".
  const allDashRow =
    numData.length === 0 &&
    dataCells.length >= 2 &&
    dataCells.every((c) => c.kind === "dash") &&
    LETTER_RE.test(text.substring(0, dataCells[0].start));
  if (numData.length === 0 && !allDashRow) return false;

  // Numeric tail check — last data cell should be in the last 50% of the line.
  const lastCell = dataCells[dataCells.length - 1];
  if (lastCell.end < text.length * 0.5) return false;

  // Reject cells with unbalanced parentheses. Real financial cells use parens
  // only for parenthesised negatives (always paired: "(१,२३४)"). A cell like
  // "(२०८०।१२" is a truncated date fragment (Salt Trading Q3 notice).
  for (const c of dataCells) {
    const opens = (c.value.match(/\(/g) || []).length;
    const closes = (c.value.match(/\)/g) || []).length;
    if (opens !== closes) return false;
  }

  // A "-" placeholder is only trusted when the entire value region is numeric;
  // otherwise "कुल रकम रु. १,२३४,५६७ - जम्मा" would become a row.
  if (numData.length !== dataCells.length &&
      LETTER_RE.test(text.slice(dataCells[0].start))) {
    return false;
  }

  // 1-2 numeric columns is the ambiguous case (a body sentence may mention two
  // numbers). Existing tightening, now counted over the NUMERIC cells only:
  //   - every numeric cell must be "financial-looking" (comma/decimal/5+ digits)
  //   - label must be 2+ words, UNLESS both cells are "strongly financial"
  //     (comma AND 7+ chars) — catches "जम्मा १,२३४,५६७ १,२३४,५६७" totals.
  // ── D5 ── "count + amount" holdings row. The standard NEPSE portfolio
  // schedule is  label | share count | valuation :
  //   "१३. प्रभु महालक्ष्मी लाइफ इन्स्योरेन्स कम्पनी लिमिटेड २७६ ११९,५३६"
  // The share count is a small BARE integer, so numData.every(isFinancialNumeric)
  // rejected the whole row; isNumberedSection then claimed it, structureToHtml
  // emitted <h3>, and each one hard-broke the portfolio grid into another
  // <table> — 4 of the 10 table breaks in post 5571. Every clause is
  // load-bearing:
  //   * exactly 2 numeric cells and NO dash cells,
  //   * the LAST must be financial -> kills "३. कुल शाखा संख्या १२ र एटीएम संख्या ८"
  //                                  and "BALANCE SHEET AS AT ASHAD 31, 2082",
  //   * the FIRST must be a bare integer of <= 4 digits (a count, not money),
  //   * nothing but cells/separators from the first data cell to EOL -> kills
  //     "कारोबार समय १०।३० देखि ३।००" and
  //     "सूचना प्रकाशित मिति २०८२।०३।३१ बिहान ११।०० बजे",
  //   * label of 2+ words.
  const countLedRow =
    numData.length === 2 &&
    numData.length === dataCells.length &&
    !isFinancialNumeric(numData[0].value) &&
    !/[,.।]/.test(numData[0].value) &&
    numData[0].value.replace(/[^\d०-९]/g, "").length <= 4 &&
    isFinancialNumeric(numData[1].value) &&
    !LETTER_RE.test(text.slice(dataCells[0].start)) &&
    DATA_ROW_TAIL_OK_RE.test(text.slice(dataCells[dataCells.length - 1].end)) &&
    text.substring(0, dataCells[0].start).trim().split(/\s+/).filter(Boolean)
      .length >= 2;

  if (numData.length <= 2 && !allDashRow && !countLedRow) {
    if (!numData.every((c) => isFinancialNumeric(c.value))) return false;
    const label = text.substring(0, dataCells[0].start).trim();
    const wordCount = label.split(/\s+/).filter((w) => w.length > 0).length;
    if (wordCount < 2) {
      const stronglyFinancial =
        numData.length >= 2 &&
        numData.every((c) => /,/.test(c.value) && c.value.length >= 7);
      if (!stronglyFinancial) return false;
    }
  }
  return true;
}

function looksLikeTableRow(block, text) {
  // Only plain <p> blocks (no <strong>/<em>/<h2>/<h3> wrappers) qualify.
  // A data row can no longer BE an <h3>/<li> — classifyLine's data-row guard
  // routes it to <p> before emission — so this gate stays as-is.
  if (!block.startsWith("<p>") || !block.endsWith("</p>")) return false;
  if (block.includes("<strong>") || block.includes("<em>")) return false;
  return looksLikeDataRowText(text);
}

// Trailing tokens permitted AFTER the last cell: danda, punctuation, percent,
// footnote marks. Anything else means the line keeps talking.
const DATA_ROW_TAIL_OK_RE = /^[\s।.,%)\-–—*†॥]*$/;

// Classifier-side guard — STRICTER than looksLikeDataRowText on purpose.
// A statement row is "label  v1  v2 …": from the first VALUE cell to the end of
// the line there are NO letters. Numbered prose always keeps words in that
// region, which is what makes this (and not "ends on a figure") the safe
// discriminator. Rejects, by hand-trace:
//   "१. साधारण शेयर १,००,००० कित्ता रु. १,००,००,०००"   (allotment list -> <ol>)
//   "३. आ.व. २०८१/८२ मा खुद नाफा १,२३४,५६७ र २०८०/८१ मा ९८७,६५४"
//   "सूचना प्रकाशित मिति २०८२।०३।३१ बिहान ११।०० बजे"     (date/time line)
//   "NOTICE FOR AUCTION OF 12,345 PROMOTER SHARES AT RS. 1,234.56"
// and accepts every post-5520 statement row. Same policy as the centered-
// heading whitelist: err strongly toward false negatives.
function looksLikeDataRowLine(line) {
  if (!looksLikeDataRowText(line)) return false;
  const { dataCells } = splitSerial(findCells(line));
  if (LETTER_RE.test(line.slice(dataCells[0].start))) return false;
  if (!DATA_ROW_TAIL_OK_RE.test(line.slice(dataCells[dataCells.length - 1].end))) return false;
  return true;
}

// A "bridge label" is a short Devanagari label paragraph that may sit
// between two data rows inside a balance sheet (e.g. "गैर चालु सम्पत्ति",
// "चालु सम्पत्ति"). When detectFinancialTables sees one between two data
// rows it absorbs it as a colspan'd section-divider <tr> inside the table
// rather than letting it break the table run into separate <table>s.
//
// Strict criteria: no digits, no parens (would catch signatures like
// "(ओमसिद्धि गुरुङ्ग)"), 1-5 whitespace-separated words, mostly
// Devanagari script.
function isBridgeLabel(text) {
  if (!text) return false;
  if (/[\d०-९()]/.test(text)) return false;
  // 2026-08-04: was Devanagari-ONLY, so an ENGLISH statement's section bands
  // ("Assets", "Liabilities", "Equity", "Total liabilities and equity") failed
  // here and hard-broke the run — post 5595 (NMB Bank interim report) shattered
  // into 18 <table>s for exactly this reason. English notices are common now
  // that english_content is generated for every announcement. Latin is accepted
  // on the SAME terms as Devanagari: no digits, no parens, 1-5 words. The
  // ALL-CAPS guard keeps real headings ("BALANCE SHEET AS AT ASHAD 31") out —
  // those are already claimed by isEnglishCapsHeading upstream anyway.
  const hasDevanagari = /[ऀ-ॿ]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  if (!hasDevanagari && !hasLatin) return false;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  // 2026-08-04: the ALL-CAPS reject was blanket, and NRB-format statements band
  // their sections in caps — "ASSETS", "EQUITY AND LIABILITIES", "CURRENT
  // LIABILITIES", "NON-CURRENT LIABILITIES". Every one of them hard-broke the
  // run, which is why 595 documents produced 2248 tables: one balance sheet
  // shattered into a table per section, and only the first kept its header.
  // Keep the reject for anything that reads like a document TITLE — 4+ words,
  // or any of the title nouns. A caps title with a date is already excluded by
  // the digit guard above.
  if (!hasDevanagari && hasLatin && text === text.toUpperCase()) {
    if (words.length >= 4) return false;
    if (/\b(?:STATEMENT|SHEET|ACCOUNT|REPORT|POSITION|ANNEXURE|SCHEDULE|NOTICE|NOTES?)\b/.test(text)) {
      return false;
    }
  }
  return words.length >= 1 && words.length <= 5;
}

// Section dividers in NEPSE statements are usually serial-led
// ("१. सूचीकृत धितोपत्रमा लगानी"), which isBridgeLabel rejects on the leading
// digit. Test the serial-stripped form but RENDER the original, so no source
// text is silently deleted. isBridgeLabel itself stays byte-identical — its
// paren reject is what keeps signatures like "(ओमसिद्धि गुरुङ्ग)" out.
function isBridgeLabelLoose(text) {
  if (!text) return false;
  if (text.includes("<")) return false;
  if (isBridgeLabel(text)) return true;
  // 2026-08-04: the serial may be a LETTER, not a digit — English statements
  // band their sections "A. Investments in Securities and Others" / "(A)
  // Commercial Bank Group". With only the digit form stripped, that line was 6
  // words, failed the 5-word cap, hit detectFinancialTables' "real break" arm
  // and spilled the COLUMN HEADER sitting above it out of the table entirely
  // (post 5507: the table then rendered with the mid-page repeat header).
  // The serial must be punctuated or parenthesised, so an ordinary first word
  // ("A Company Limited") is never eaten.
  // Devanagari letter serials "(क) वाणिज्य बैंक समूह" / "(ख) विकास बैंक समूह" band
  // the sector groups in every NEPSE portfolio disclosure and were rejected on
  // the parens, breaking the run once per sector.
  const stripped = text
    .replace(/^(?:\((?:[०-९]+|\d+|[A-Za-z]|[ऀ-ॿ]{1,3}|[IVXivx]{2,4})\)|(?:[०-९]+|\d+|[A-Za-z]|[ऀ-ॿ]{1,3}|[IVXivx]{2,4})\s*[.।:])\s*/, "")
    .trim();
  return stripped !== text && isBridgeLabel(stripped);
}

// Column-label row of a statement table:
//   "क्र.सं. विवरण यस मासिक मसान्तमा रकम (रु.) गत मासिक मसान्तमा रकम (रु.)"
//   "S.N. Particulars Amount as at this month end (Rs.) …"
// Deliberately narrow — a false positive turns prose into a table header, which
// reads as document vandalism. Hardenings: the strong marker must appear in the
// FRONT 40% of the line (stops the statement TITLE from becoming the header),
// TWO distinct weak markers are required, and "S.N." is case-sensitive +
// period-bearing (a loose /s\.?n\.?/i matches "shares not").
// "Particulars?" — several issuers write the label column SINGULAR ("Particular
// Ashad End 2083", "Particular Current Year This Quarter …"). One missing
// character cost every table in those notices its header.
const HEADER_STRONG_RE =
  /(?:^|\s)(?:क्र\.?\s*सं|विवरण|शीर्षक|Particulars?|Description|S\.\s?N\.?|SN|S\/N)(?=[\s.:।]|$)/;
const HEADER_WEAK_RES = [
  /रकम/, /मसान्त/, /त्रैमास/, /आ\.?\s*व\.?/, /रु\./, /महिना/, /वर्ष/, /असार/,
  /\bamount\b/i, /\brs\.?\b/i, /\bquarter\b/i, /\bmonth\b/i, /\byear\b/i,
  /\bend(?:ed|ing)?\b/i, /\bbalance\b/i,
  // 2026-08-04: PERIOD/DATE markers. Many statements label their value columns
  // by DATE rather than by "This Quarter / Amount":
  //   "Particulars As on 32nd Ashadh 2080 (16th July 2023) (Unaudited) As on
  //    30th Chaitra 2079 (13th April 2023) (Unaudited) As on 32nd Ashadh 2079
  //    (16th July 2022) (Audited)"
  // (Upper Lohore Khola Hydropower). That header matched ZERO of the markers
  // above, so weak was 0 and the row was rejected outright.
  /\bas\s+on\b/i, /\bas\s+at\b/i, /\bun\s?audited\b/i, /\baudited\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i,
  /(?:आषाढ|असोज|कात्तिक|मंसिर|पुष|माघ|फागुन|चैत|बैशाख|जेठ|साउन|भदौ)/,
  // Nepali (Bikram Sambat) months TRANSLITERATED — the english_content of a
  // statement labels its columns "Ashad 2079 (Rs.) Jestha 2079 (Rs.)", which
  // matched no marker at all (the Devanagari list above can't see Latin, and
  // the Gregorian list has no "Ashad"). Corpus audit, 2026-08-04.
  /\b(?:baishakh|baisakh|jestha|jeth|ashadh?|asar|ashar|shrawan|srawan|saun|bhadra|bhadau|ashwin|asoj|kartik|kattik|mangsir|marga|poush|push|pus|magh|falgun|fagun|phalgun|chaitra|chait)\b/i,
  /अपरिष्कृत/, /लेखापरीक्षित/,
  // FISCAL-YEAR column labels. "Particulars Note FY 2081/82 FY 2080/81"
  // (post 5614) matched NOTHING above — no "quarter", no "year", no month name —
  // so weak was 0 and the header was rejected outright: 13 tables, 0 <thead>.
  // Two independent markers because the fiscal-year RANGE ("2081/82") is itself
  // a period label even when the "FY" prefix is missing. Devanagari digits do
  // not match \d, so Nepali prose carrying "आ.व. २०८१/८२" is unaffected.
  /\bF\.?\s?Y\.?\b/i, /\b\d{4}\s*\/\s*\d{2,4}\b/,
  /\bYTD\b/i, /\bup\s?to\b/i,
  // Period QUALIFIERS. "Particulars Current Year Previous Year Corresponding"
  // is the scope line of a hierarchical quarterly header and matched only
  // \byear\b, so weak was 1 and the whole two-line header was rejected.
  /\bcorresponding\b/i, /\bpreceding\b/i,
];

// COLUMN-NOUN markers — what a column COUNTS rather than the period it covers:
//   "क्र.सं. विवरण यस मासिक मसान्त सम्पत्ति मूल्य गत मासिक मसान्त सम्पत्ति मूल्य"
// Deliberately NOT in HEADER_WEAK_RES. These words are common in ordinary
// notice prose ("जम्मा मूल्य बुझाई …", "the total value of units held by each
// shareholder"), so counting them toward the plain weak>=2 test turned four out
// of five adversarial prose sentences into header rows. They are admitted only
// alongside PROOF that the line carves into short column labels.
const HEADER_COLNOUN_RES = [
  /\bunits?\b/i, /\bquantity\b/i, /\bvalues?\b/i, /\bnumber\b/i, /\btotal\b/i,
  /मूल्य/, /संख्या/, /इकाई/, /कित्ता/, /जम्मा/, /मासिक/, /सम्पत्ति/, /धितोपत्र/,
];

// The line splits into 3+ columns whose VALUE labels are all short. A prose
// sentence that happens to carry an anchor word does not: its parts run long.
function splitsIntoShortColumns(text) {
  for (let cols = 3; cols <= 9; cols++) {
    const parts = headerCellsOneLine(text, cols);
    if (!parts) continue;
    if (parts.slice(1).every((c) => c.split(/\s+/).filter(Boolean).length <= 6)) return true;
  }
  return false;
}
function isTableHeaderRowLine(text) {
  if (!text) return false;
  if (text.includes("<")) return false;                 // never trust markup as a header
  if (/।\s*$/.test(text)) return false;                 // sentence-terminal danda -> prose
  // A header carries no MONEY cell (a bare year like "२०८२" is fine and common).
  if (findCells(text).some((c) => c.kind === "num" && isFinancialNumeric(c.value))) return false;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 3) return false;
  // 2026-08-04: the flat 24-word cap rejected date-labelled headers, which are
  // long by nature — the Upper Lohore Khola header is 28 words ("Particulars"
  // + three "As on <BS date> (<AD date>) (Un/Audited)" columns). Raise the
  // ceiling, but above the old cap demand STRUCTURAL proof (equal-width,
  // marker-bearing repeated columns) rather than trusting word counts alone, so
  // a long prose sentence that happens to open with "विवरण" still can't pass.
  if (words.length > 44) return false;
  if (words.length > 24 && !hasRepeatedColumnStructure(text)) return false;
  // 2026-08-04: test the weak markers against an UNDERSCORE-NORMALISED copy.
  // When the source has a TWO-LEVEL header (NMB Bank interim report: Group/NMB
  // over This-Quarter/Prev-Year), Gemini flattens the hierarchy into
  // underscore-joined labels — "Group_This_Quarter_Ending". `_` is a word
  // character, so \bquarter\b / \byear\b / \bend(ing)?\b never matched, weak
  // came out 0, and the whole header row was rejected (post 5595: 18 tables,
  // 0 <thead>). Matching is all this copy is used for; the ORIGINAL text is
  // still what gets split and rendered.
  const markerText = text.replace(/_/g, " ");
  let weak = 0;
  for (const re of HEADER_WEAK_RES) if (re.test(markerText)) weak++;
  const m = HEADER_STRONG_RE.exec(text);
  if (!m) {
    // ── HEADERLESS LABEL COLUMN ──
    // NRB-format balance sheets print the Particulars column heading BLANK and
    // label only the value columns:
    //   "Group This Quarter Ending Immediate Previous Year Ending (Audited)
    //    Bank This Quarter Ending Immediate Previous Year Ending (Audited)"
    // No strong marker exists, so this returned false, the line stayed a <p>,
    // and the table opened on the "Assets" section band — which the reader then
    // sees as the header. Largest single failure class in the 2026-08-04 corpus
    // audit (110 of 215 header-less tables: 56 "Assets", 14 "Liabilities",
    // 14 "Non-Current Assets", plus variants). Accept ONLY the flattened
    // two-level shape that splitScopedHeader can prove and then actually
    // render; prose never tiles into repeated scope+period blocks.
    return weak >= 2 && (hasScopedColumnStructure(text) || hasLabelledColumnStructure(text));
  }
  if (m.index > text.length * 0.4) return false;        // label column comes FIRST
  if (weak >= 2) return true;
  // Column-noun path — see HEADER_COLNOUN_RES. Needs a demonstrable split, so
  // "विवरण अनुसार जम्मा मूल्य बुझाई …" (two nouns, no columns) stays prose.
  const colNoun = HEADER_COLNOUN_RES.filter((re) => re.test(markerText)).length;
  if (colNoun >= 1 && weak + colNoun >= 2 && splitsIntoShortColumns(text)) return true;
  // ── D1 ── Two-PRINTED-LINE header (post 5571). The grid's header occupies two
  // rows: "क्र.सं. विवरण २०८३ आषाढ मसान्त २०८३ ज्येष्ठ मसान्त" then
  // "रकम (रु.) रकम (रु.)". Line 1 alone carries only ONE distinct weak marker
  // (/मसान्त/ — /आ\.?\s*व\.?/ does NOT match "आषाढ"), so weak>=2 rejected it and
  // every reprint of the pair hard-broke the run: 11 <table>, 0 <thead>.
  // Accept a single-marker line ONLY when it demonstrably carves into
  // equal-width value columns that each carry that marker. A bare repeat COUNT
  // is not enough — it would admit prose like
  // "विवरण अनुसार रकम बुझाई रकम फिर्ता गर्नु पर्नेछ", whose two रकम sit at unequal
  // spacing. The equal-width test rejects that.
  if (weak >= 1 && hasRepeatedColumnStructure(text)) return true;
  // Underscore-joined column labels are themselves strong evidence of a
  // flattened multi-level header: real prose never contains 2+ such tokens.
  return (text.match(/\w_\w/g) || []).length >= 2;
}

// True when the tail of `text` splits into 2-4 EQUAL-WIDTH value columns that
// each carry a weak header marker. Prose does not accidentally have this shape.
function hasRepeatedColumnStructure(text) {
  for (let cols = 3; cols <= 5; cols++) {
    const parts = splitRepeatedAnchor(text, cols);
    if (!parts) continue;
    const vals = parts.slice(1);
    if (!vals.every((v) => v.split(/\s+/).filter(Boolean).length >= 2)) continue;
    if (!vals.every((v) => HEADER_WEAK_RES.some((re) => re.test(v)))) continue;
    return true;
  }
  return false;
}

// ── D1 ── The UNIT row of a two-printed-line header: "रकम (रु.) रकम (रु.)" /
// "मूल्य (रु.) मूल्य (रु.)" / "Amount (Rs.) Amount (Rs.)". No strong marker, no
// label column, no cells — on its own it is a HARD BREAK, the second half of the
// 11-table shatter. NOT wired into classifyLine: such a line already returns
// "para" today, so the classifier needs no change and the pinned cases are
// untouched by construction. Consulted ONLY by detectFinancialTables, and only
// when a header is already sitting in `pending`. Kept airless on purpose: EVERY
// token must be a currency/unit word AND the line must be n identical groups.
const HEADER_UNIT_TOKEN_RE =
  /^[(\[]?(?:रकम|मूल्य|रु\.|रु|कैफियत|Amounts?|Rs\.|Rs|NPR|Value|Figures)[)\]]?[.,:;]?$/i;
function isHeaderUnitContinuationLine(text) {
  if (!text) return false;
  if (text.includes("<")) return false;
  if (/[\d०-९]/.test(text)) return false;
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length < 4 || toks.length > 8) return false;
  if (!toks.every((t) => HEADER_UNIT_TOKEN_RE.test(t))) return false;
  for (let n = 2; n <= 4; n++) {
    if (toks.length % n !== 0) continue;
    const k = toks.length / n;
    let same = true;
    for (let g = 1; g < n && same; g++) {
      for (let p = 0; p < k; p++) {
        if (toks[g * k + p] !== toks[p]) { same = false; break; }
      }
    }
    if (same) return true;
  }
  return false;
}

// Split the single header LINE into exactly `cols` cells, or null.
// null => the caller renders the header as a full-width divider row rather than
// risk putting a column label over the wrong figures.
// Data rows keep their क्र.सं. serial INSIDE the label cell (tableRowFromText),
// so the header's serial + particulars columns must come out MERGED — which is
// exactly what a value-qualifier-anchored split produces.
// 2026-08-04: anchors are now TIERED, and tier 1 is tried alone first.
//
// The flat list below (now tier 2) mis-split the LIC Nepal header. Source has a
// TWO-LEVEL head — "Unaudited" / "Audited" sitting above "At the end of this
// Quarter" / "At the end of Immediate Previous Year" — which Gemini flattens to
//   "Particulars Unaudited At the end of this Quarter Audited At the end of
//    Immediate Previous Year"
// Splitting on `Immediate` and `Previous` yields exactly cols(3) parts, so it
// was ACCEPTED even though the boundaries are meaningless:
//   ["Particulars Unaudited At the end of this Quarter Audited At the end of",
//    "Immediate", "Previous Year"]
// `Immediate`/`Previous`/`Current` are MID-PHRASE words ("…of Immediate
// Previous Year"); only tier 1 words actually OPEN a column. Trying tier 1
// alone first gives the correct 3-way split before "Unaudited" and "Audited".
// Anchor sets are GRADUATED: the smallest set is tried first and we stop at the
// first one that yields exactly `cols` cells. Two fixed tiers weren't enough —
// the two real notices pull in opposite directions:
//
//   LIC        "Particulars Unaudited At the end of this Quarter Audited At the
//               end of Immediate Previous Year"            (cols 3)
//              needs Immediate/Previous NOT to split (they are mid-phrase);
//              tier 1 alone gives the right 3.
//   Dhaulagiri "Particulars This Quarter Ending Immediate Previous Year Ending"
//                                                          (cols 3)
//              needs Immediate to OPEN a column — tier 1 alone gives only 2,
//              and adding Previous as well overshoots to 4.
//
// So `Immediate` must be available but only when the tighter set has already
// failed, and `Previous` only after that. Ordering by increasing looseness is
// what lets one rule serve both.
const HEADER_SPLIT_SETS = [
  // 1. True column openers only.
  /\s+(?=(?:यस|यो|गत|विगत|चालु|अघिल्लो|अघिको|हालको|आगामी|पछिल्लो|तत्काल|This|Un-?[Aa]udited|Audited|As\s+on|As\s+at))/g,
  // 2. + period qualifiers that commonly START a column.
  /\s+(?=(?:यस|यो|गत|विगत|चालु|अघिल्लो|अघिको|हालको|आगामी|पछिल्लो|तत्काल|This|Un-?[Aa]udited|Audited|As\s+on|As\s+at|Immediate|Corresponding|Preceding))/g,
  // 3. + the rest (loosest; can split mid-phrase, hence last).
  /\s+(?=(?:यस|यो|गत|विगत|चालु|अघिल्लो|अघिको|हालको|आगामी|पछिल्लो|तत्काल|This|Un-?[Aa]udited|Audited|As\s+on|As\s+at|Immediate|Corresponding|Preceding|Previous|Current|Amount|Balance|Figures|Rs\.|Upto|Up\s+to|YTD))/g,
  // 4. Scope-prefixed columns — "Group-This Quarter Ending Group-Immediate
  // Previous Year Ending Bank-This Quarter Ending" (post 5619) and the colon
  // form "Group: This Quarter Ending Group: Immediate …" (post 5631). Gemini
  // renders a two-level header this way when the grid uses a spanning cell.
  // No anchor WORD exists for these, but the "<Scope>-" / "<Scope>:" token is a
  // reliable column OPENER. Last and loosest: it only fires on a line the header
  // test already accepted, and only when it yields exactly `cols` parts.
  /\s+(?=[A-Z][A-Za-z]{1,14}[-:])/g,
];
const HEADER_TAIL_UNIT_RE = /(?:रकम|Amount|रु\.|Rs\.)/g;

// A part that is ONLY a qualifier opens the next column, it does not close the
// previous one. "This Quarter Upto This Quarter(YTD)" split on the loosest set
// yields [This Quarter][Upto][This Quarter(YTD)]; without this merge the tighter
// set is chosen instead and produces [This Quarter Upto][This Quarter(YTD)] —
// right column COUNT, boundary off by one token, so the reader is told the
// second column is the year-to-date one when it is not.
const QUALIFIER_ONLY_RE = /^(?:Upto|Up\s+to|YTD|As\s+on|As\s+at|तर्फ|सम्मको)$/i;
// The mirror case: a word that CLOSES the column it lands in. "Corresponding"
// is in the anchor sets as an opener ("Corresponding This Quarter"), but in
// "Particulars Current Year Previous Year Corresponding" it terminates the
// second scope — the loosest set cut it off into a part of its own and made a
// 3-column scope line look like 4.
const TRAILER_ONLY_RE = /^(?:Corresponding|Ending|Ended|Audited|Un-?audited)$/i;
function anchorSplit(text, re) {
  re.lastIndex = 0;
  const raw = text.split(re).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (QUALIFIER_ONLY_RE.test(raw[i]) && i + 1 < raw.length) {
      out.push(`${raw[i]} ${raw[++i]}`.trim());
    } else if (TRAILER_ONLY_RE.test(raw[i]) && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]} ${raw[i]}`.trim();
    } else {
      out.push(raw[i]);
    }
  }
  return out;
}

// A column label never ENDS on a qualifier — "This Quarter Upto" is the tighter
// anchor set cutting one token late, stealing the "Upto" that opens the next
// column. Reject that reading so a looser set (which has an anchor for the
// qualifier, and whose stray "Upto" part anchorSplit merges forward) is used.
function anchorSplitValid(parts) {
  return parts.every(
    (p) => p && !QUALIFIER_ONLY_RE.test(p.split(/\s+/).filter(Boolean).pop() || "")
  );
}

// Split `text` into exactly `n` columns using the tightest anchor set that hits.
function splitAnchorParts(text, n) {
  if (n < 1) return null;
  if (n === 1) return [text.trim()];
  for (const re of HEADER_SPLIT_SETS) {
    const parts = anchorSplit(text, re);
    if (parts.length === n && anchorSplitValid(parts)) return parts;
  }
  return null;
}

// A HIERARCHICAL two-printed-line header — the single most common shape in a
// NEPSE quarterly report:
//   "Particulars Current Year Previous Year Corresponding"
//   "This Quarter Upto This Quarter(YTD) This Quarter Upto This Quarter(YTD)"
// Line 1 is the label plus `s` SCOPES, line 2 is `s * p` sub-labels, and the
// real columns are their cross product: 1 + s*p. headerCells' per-line zip
// cannot express this — it needs both lines to split into the SAME count — so
// every one of these tables rendered with no <thead>.
function headerCellsTwoLevel(l1, l2, cols) {
  for (let s = 2; s <= 4; s++) {
    if ((cols - 1) % s !== 0) continue;
    const p = (cols - 1) / s;
    if (p < 1) continue;
    const top = splitAnchorParts(l1, s + 1);
    const sub = splitAnchorParts(l2, s * p);
    if (!top || !sub) continue;
    const cells = [top[0]];
    for (let i = 0; i < s; i++) {
      for (let j = 0; j < p; j++) cells.push(`${top[i + 1]} ${sub[i * p + j]}`.trim());
    }
    if (cells.length === cols && cells.slice(1).every(Boolean)) return cells;
  }
  return null;
}

// The SUB-LABEL line of a hierarchical header: `n` byte-identical groups, each
// carrying a period marker. Byte-identity is the whole safety story — the two
// halves of a real sub-label row are the same period pair reprinted under each
// scope, which prose never is.
function isHeaderSubLabelLine(text) {
  if (!text || text.includes("<")) return false;
  if (/।\s*$/.test(text)) return false;
  if (findCells(text).some((c) => c.kind === "num" && isFinancialNumeric(c.value))) return false;
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length < 4 || toks.length > 20) return false;
  for (let n = 2; n <= 4; n++) {
    if (toks.length % n !== 0) continue;
    const k = toks.length / n;
    if (k < 2) continue;
    const groups = [];
    for (let i = 0; i < n; i++) groups.push(toks.slice(i * k, (i + 1) * k).join(" "));
    if (!groups.every((g) => g === groups[0])) continue;
    if (!HEADER_WEAK_RES.some((re) => re.test(groups[0]))) continue;
    return true;
  }
  return false;
}

// Value columns whose labels are IDENTICAL ("… रकम (रु.) रकम (रु.)") carry no
// qualifier to anchor on. Detect the repetition instead: the last n*k tokens
// must be n identical k-token groups.
function splitRepeatedSuffix(text, cols) {
  const n = cols - 1;
  if (n < 2) return null;
  const toks = text.split(/\s+/).filter(Boolean);
  for (let k = 1; k * n < toks.length; k++) {
    const groups = [];
    for (let c = n; c >= 1; c--) {
      groups.push(toks.slice(toks.length - c * k, toks.length - (c - 1) * k).join(" "));
    }
    if (groups.every((g) => g === groups[0])) {
      const label = toks.slice(0, toks.length - n * k).join(" ");
      if (label) return [label, ...groups];
    }
  }
  return null;
}

// Value columns that repeat a common ANCHOR token with a differing middle
// ("२०८३ आषाढ मसान्त" / "२०८३ ज्येष्ठ मसान्त") are invisible to
// splitRepeatedSuffix's byte-equality test, and HEADER_SPLIT_RE has no anchor
// word for them. Find a token occurring exactly cols-1 times, never at position
// 0, whose occurrences carve the tail into EQUAL-LENGTH groups of 2+ tokens —
// that equal-length constraint is the entire safety story ("मसान्त" at [4,7]
// gives spans [3,1] and is correctly rejected; "२०८३" at [2,5] gives [3,3]).
// DETERMINISTIC: among valid anchors take the one leaving the LONGEST label.
// Exhaustive by construction — every token lands in exactly one cell.
function splitRepeatedAnchor(text, cols) {
  const n = cols - 1;
  if (n < 2) return null;
  const toks = text.split(/\s+/).filter(Boolean);
  const at = new Map();
  toks.forEach((t, i) => { if (!at.has(t)) at.set(t, []); at.get(t).push(i); });
  let best = null;
  for (const [, pos] of at) {
    if (pos.length !== n) continue;
    if (pos[0] < 1) continue;                       // a label column must remain
    const span = (i) => (i + 1 < pos.length ? pos[i + 1] : toks.length) - pos[i];
    const w = span(0);
    if (w < 2) continue;                            // 1-token columns are noise
    let ok = true;
    for (let i = 1; i < pos.length; i++) if (span(i) !== w) { ok = false; break; }
    if (!ok) continue;
    if (best === null || pos[0] < best.pos0) {
      const cells = [toks.slice(0, pos[0]).join(" ")];
      for (let i = 0; i < pos.length; i++) {
        cells.push(
          toks.slice(pos[i], i + 1 < pos.length ? pos[i + 1] : toks.length).join(" ")
        );
      }
      best = { pos0: pos[0], cells };
    }
  }
  return best ? best.cells : null;
}

// Columns that each END with a currency unit — "S.N. Description Ashad 2079
// (Rs.) Jestha 2079 (Rs.)". No anchor word opens these columns and the groups
// aren't byte-identical ("Ashad" vs "Jestha"), so neither the anchor nor the
// repeated-suffix splitter fires. The unit token is the reliable column
// TERMINATOR: if it appears exactly cols-1 times and the line ENDS with one,
// cut after each occurrence. Found by the 2026-08-04 corpus audit.
const UNIT_TOKEN_RE = /^\(?(?:rs\.?|रु\.?|npr|nrs\.?)\)?[.,:;]?$/i;
function splitByTrailingUnit(text, cols) {
  const n = cols - 1;
  if (n < 2) return null;                                   // cols===2 has its own path
  const toks = text.split(/\s+/).filter(Boolean);
  const at = [];
  toks.forEach((t, i) => { if (UNIT_TOKEN_RE.test(t)) at.push(i); });
  if (at.length !== n) return null;                         // one unit per value column
  if (at[at.length - 1] !== toks.length - 1) return null;    // line must END on a unit
  // Value columns in these headers are uniform, so take the LAST column's token
  // width (tokens after the previous unit) and apply it to all of them. What
  // remains in front is the label column.
  const w = at[n - 1] - at[n - 2];
  if (w < 2) return null;
  const labelEnd = toks.length - n * w;
  if (labelEnd < 1) return null;                            // no label column left
  // Every inferred boundary must actually land on a unit token, else the
  // uniform-width assumption is wrong for this header and we bail.
  for (let i = 0; i < n; i++) {
    if (at[i] !== labelEnd + (i + 1) * w - 1) return null;
  }
  const cells = [toks.slice(0, labelEnd).join(' ').trim()];
  for (let i = 0; i < n; i++) {
    cells.push(toks.slice(labelEnd + i * w, labelEnd + (i + 1) * w).join(' ').trim());
  }
  return cells.every(Boolean) ? cells : null;
}

// The unit row of a two-line header has cols-1 IDENTICAL groups and NO label
// column, which splitRepeatedSuffix cannot express (its loop guard k*n <
// toks.length excludes the label-less case). Returns ["", g1, g2, …].
// A TWO-LEVEL header flattened onto one line with the label column left blank:
//   "Group This Quarter Ending Immediate Previous Year Ending (Audited)
//    Bank  This Quarter Ending Immediate Previous Year Ending (Audited)"
// = 2 scopes (Group/Bank) x 2 periods = 4 value columns + a blank Particulars
// corner. The line tiles into `s` equal-width segments that share a common
// token SUFFIX (the period block); what precedes the shared block in each
// segment is that segment's scope. The shared-suffix + equal-width + distinct-
// scopes triple is what makes this safe — a prose sentence does not tile.
// Returns cells with an EMPTY first cell (the blank corner), which is exactly
// what the source prints; nothing is invented.
function splitScopedHeader(text, cols) {
  const toks = text.split(/\s+/).filter(Boolean);
  // The label column, when the line has one. Scopes need NOT be equal width —
  // "Current Year" vs "Previous year corresponding" (post 5637) — so the split
  // is driven by the repeated BLOCK, not by tiling the line into equal segments.
  const labelLens = [0];
  const sm = HEADER_STRONG_RE.exec(text);
  if (sm && sm.index <= 2) {
    const pre = text.slice(0, sm.index + sm[0].length).trim();
    const len = pre.split(/\s+/).filter(Boolean).length;
    if (len >= 1 && len < toks.length - 3) labelLens.push(len);
  }
  for (const labelLen of labelLens) {
    const body = toks.slice(labelLen);
    const n = body.length;
    for (let s = 2; s <= 4; s++) {
      // LONGEST shared block first — the longest repeat is the most specific
      // reading, and a shorter one can coincidentally satisfy `cols` with the
      // scope words sliced in the wrong place.
      for (let k = Math.floor(n / s); k >= 2; k--) {
        const block = body.slice(n - k).join(" ");
        const occ = [];
        for (let i = 0; i + k <= n; i++) {
          if (occ.length && i < occ[occ.length - 1] + k) continue;   // non-overlapping
          if (body.slice(i, i + k).join(" ") === block) occ.push(i);
        }
        if (occ.length !== s) continue;
        if (occ[s - 1] !== n - k) continue;              // last repeat ends the line
        const scopes = [];
        let ok = true;
        for (let i = 0; i < s; i++) {
          const start = i === 0 ? 0 : occ[i - 1] + k;
          if (occ[i] - start < 1) { ok = false; break; }  // every scope needs a word
          scopes.push(body.slice(start, occ[i]).join(" "));
        }
        if (!ok || new Set(scopes).size !== s) continue;
        for (const re of HEADER_SPLIT_SETS) {
          re.lastIndex = 0;
          const parts = block.split(re).map((x) => x.trim()).filter(Boolean);
          if (parts.length < 2 || parts.length * s + 1 !== cols) continue;
          const cells = [labelLen ? toks.slice(0, labelLen).join(" ") : ""];
          for (const sc of scopes) for (const p of parts) cells.push(`${sc} ${p}`.trim());
          if (cells.length === cols && cells.slice(1).every(Boolean)) return cells;
        }
      }
    }
  }
  return null;
}

function hasScopedColumnStructure(text) {
  for (let cols = 3; cols <= 9; cols++) if (splitScopedHeader(text, cols)) return true;
  return false;
}

// A header with no strong marker whose label column is a plain noun rather than
// the word "Particulars": "Assets This Quarter Ending Immediate Previous Year
// Ending" (20 tables in the 2026-08-04 corpus audit — the reader saw no header
// at all). The columns do NOT repeat, so splitScopedHeader cannot see it.
// Accept only when an anchor set carves the line into 3+ parts where EVERY
// value column carries a weak marker and the LABEL column carries none and is
// at most 3 words — the shape of a column header, which prose does not have.
function hasLabelledColumnStructure(text) {
  for (const re of HEADER_SPLIT_SETS) {
    re.lastIndex = 0;
    const parts = text.split(re).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3 || parts.length > 9) continue;
    const label = parts[0];
    if (label.split(/\s+/).filter(Boolean).length > 3) continue;
    if (HEADER_WEAK_RES.some((w) => w.test(label))) continue;
    if (!parts.slice(1).every((p) => HEADER_WEAK_RES.some((w) => w.test(p)))) continue;
    if (!parts.slice(1).every((p) => p.split(/\s+/).filter(Boolean).length >= 2)) continue;
    return true;
  }
  return false;
}

function continuationCells(text, cols) {
  const n = cols - 1;
  if (n < 1) return null;
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length === 0 || toks.length % n !== 0) return null;
  const k = toks.length / n;
  const groups = [];
  for (let i = 0; i < n; i++) groups.push(toks.slice(i * k, (i + 1) * k).join(" "));
  if (!groups.every((g) => g === groups[0])) return null;
  return ["", ...groups];
}

// Single-line split — byte-identical to the pre-2026-07-31 headerCells.
function headerCellsOneLine(text, cols) {
  if (cols < 2) return null;
  // Tightest anchor set first; stop at the first that hits `cols` exactly.
  for (const re of HEADER_SPLIT_SETS) {
    const parts = anchorSplit(text, re);
    if (parts.length === cols && anchorSplitValid(parts)) return parts;
  }
  const b = splitRepeatedSuffix(text, cols);
  if (b) return b;
  const u = splitByTrailingUnit(text, cols);
  if (u) return u;
  // One whitespace-separated token per column. Only fires when the count
  // matches EXACTLY, which is the shape produced when Gemini flattens a
  // multi-level header into underscore-joined labels:
  //   "Particulars Group_This_Quarter_Ending … NMB_Immediate_Previous_Year_Ending"
  // = 5 tokens for a 5-column table. Underscores are rendered back as spaces so
  // the <th> reads "Group This Quarter Ending". Tried only AFTER the anchored
  // splitters, so multi-word Nepali headers are unaffected.
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length === cols && toks.some((t) => /\w_\w/.test(t))) {
    return toks.map((t) => t.replace(/_/g, " ").trim());
  }
  if (cols === 2) {                                     // single value column
    HEADER_TAIL_UNIT_RE.lastIndex = 0;
    let last = -1, m;
    while ((m = HEADER_TAIL_UNIT_RE.exec(text)) !== null) last = m.index;
    if (last > text.length * 0.5) {
      const l = text.slice(0, last).trim();
      const r = text.slice(last).trim();
      if (l && r) return [l, r];
    }
  }
  return null;
}

// Split a header's PRINTED LINES into exactly `cols` cells, or null.
// null => the caller renders the header as a full-width divider row rather than
// risk putting a column label over the wrong figures.
// A two-line header must be split PER LINE and ZIPPED per column. Concatenating
// the lines first and splitting once produces
//   ["क्र.सं. विवरण २०८३ आषाढ मसान्त २०८३ ज्येष्ठ मसान्त", "रकम (रु.)", "रकम (रु.)"]
// (splitRepeatedSuffix fires at k=2), i.e. both period names crammed into the
// label column — the reader cannot tell which column is आषाढ.
// splitRepeatedAnchor is reachable ONLY from the multi-line path, so every
// single-line header that splits today splits byte-identically today.
function headerCells(input, cols) {
  const texts = Array.isArray(input) ? input : [input];
  if (cols < 2 || texts.length === 0) return null;
  const per = [];
  for (let i = 0; i < texts.length; i++) {
    let row;
    if (i === 0) {
      // A header with NO strong marker is a blank-corner two-level header (the
      // only shape isTableHeaderRowLine admits without one). Its scoped split
      // must run FIRST: the generic anchor sets also reach `cols` on these
      // lines, but by cutting mid-phrase — post 5601 came out as
      // "Immediate Previous Year Ending (Audited) Bank", gluing the second
      // scope word onto the first scope's last column.
      if (!HEADER_STRONG_RE.test(texts[i])) row = splitScopedHeader(texts[i], cols);
      if (!row) row = headerCellsOneLine(texts[i], cols);
      // 2026-07-31: splitRepeatedAnchor was gated to the multi-line path, but
      // OCR often returns the whole two-row header ALREADY merged onto one line
      // ("क्र.सं. विवरण २०८१ आषाढ मसान्त रकम (रू.) २०८१ जेष्ठ मसान्त रकम (रू.)" —
      // real output for post 5571). HEADER_SPLIT_RE has no anchor word for it and
      // splitRepeatedSuffix needs byte-identical tail groups, so headerCells
      // returned null and the row was demoted to a full-width divider band with
      // no <thead> at all. Running the anchor split on single-line headers too
      // is strictly additive: it is tried only AFTER the two existing splitters
      // have failed, so every header that splits today splits identically.
      if (!row) row = splitRepeatedAnchor(texts[i], cols);
      if (!row) row = splitScopedHeader(texts[i], cols);
    } else {
      row = continuationCells(texts[i], cols);
    }
    if (!row || row.length !== cols) {
      // Per-line zip needs both printed lines to split into the SAME count. A
      // hierarchical pair (scopes over periods) never does — fall back to the
      // cross product. Tried only after the zip fails, so every two-line header
      // that splits today splits identically.
      return texts.length === 2 ? headerCellsTwoLevel(texts[0], texts[1], cols) : null;
    }
    per.push(row);
  }
  if (per.length === 0) return null;
  const zipped = [];
  for (let c = 0; c < cols; c++) {
    zipped.push(per.map((r) => r[c]).filter(Boolean).join(" ").trim());
  }
  // Cell 0 may legitimately be EMPTY: splitScopedHeader returns the blank
  // Particulars corner that the source itself prints blank. Every VALUE column
  // must still carry a label — an empty one there means the split was wrong.
  return zipped.slice(1).every((c) => c.length > 0) ? zipped : null;
}

function tableRowFromText(text) {
  const cells = findCells(text);
  if (cells.length === 0) return null;
  // Leading serial ("१ सूचीकृत शेयर …" / "१. बैंक मौज्दात …") stays inside the
  // label cell so every row is uniform [label, col1, col2] — matching the
  // serial-less जम्मा totals. Dash cells emit "-" verbatim (source-faithful; a
  // blank <td> reads as a rendering bug).
  const { dataCells } = splitSerial(cells);
  const label = text.substring(0, dataCells[0].start).trim();
  const values = dataCells.map((c) => c.value);
  return [label, ...values];
}

// ── D3 ── WRAPPED LABEL. A row label too long for its column wraps onto two
// printed lines, with the figures beside the SECOND one:
//   "४. सार्वजनिक निष्काशन/हकप्रद शेयर/"                    <- fragment, no figures
//   "बोनस शेयर/अन्य सूचीकृत नभएको ५४४,३०६,४९५ ५१३,६४५,४८५"  <- real data row
// Today the fragment becomes an emerald divider band and the continuation a
// label-less row. Discriminator against a genuine section band: the fragment
// ends on a "/" AND the following row's own label carries no serial (the serial
// stayed up on the fragment). "/" ONLY — a trailing comma or hyphen is a live
// hazard on OCR'd bands. None of धितोपत्रमा लगानी / चालु सम्पत्ति / चालु दायित्व /
// आम्दानी / खर्च can be eaten by this.
const WRAPPED_LABEL_TAIL_RE = /\/$/;
const ROW_SERIAL_PREFIX_RE = /^(?:[०-९]+|\d+)\s*[.।:]?\s+/;
function isWrappedLabelFragment(fragText, rowLabel) {
  if (!fragText || !rowLabel) return false;
  const frag = fragText.trim();
  if (!WRAPPED_LABEL_TAIL_RE.test(frag)) return false;
  if (!LETTER_RE.test(frag)) return false;
  const words = frag.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return false;
  const cells = findCells(frag);                     // carries no figures…
  if (cells.length > 1) return false;
  if (cells.length === 1 &&
      !(cells[0].start < 3 && cells[0].kind === "num" && isSerialCell(cells[0].value))) {
    return false;                                    // …beyond a leading serial
  }
  if (ROW_SERIAL_PREFIX_RE.test(rowLabel)) return false;
  return true;
}

// ── D4 ── ORPHAN VALUES. A label whose figures were printed on their own line:
//   "खुद् सम्पत्ति (ग्रस)"
//   "१०,०४८,३१७,८५७ १०,२५२,०४४,१३९"
// The values line opens at index 0, so splitSerial rejects it and BOTH lines
// strand outside the table. LETTER_RE excludes ०-९, so "no letter anywhere" is a
// valid values-only test on Devanagari digits.
function isValuesOnlyLine(text) {
  if (!text) return false;
  if (LETTER_RE.test(text)) return false;
  const cells = findCells(text);
  if (cells.length < 2) return false;
  if (cells[0].start > 2) return false;
  if (!cells.every((c) => c.kind === "num" && isFinancialNumeric(c.value))) return false;
  return DATA_ROW_TAIL_OK_RE.test(text.slice(cells[cells.length - 1].end));
}

// The label half. Deliberately LOOSER than isBridgeLabel (must accept
// "खुद् सम्पत्ति (ग्रस)", which isBridgeLabel rejects on the parens) but hardened
// against the shape that loosening exposes: a wholly parenthesised line is a
// SIGNATURE ("(ओमसिद्धि गुरुङ्ग)"), never a row label. Word cap matches
// isBridgeLabel's 5 so a 6-8 word band cannot slip past the !isBridgeLabelLoose
// gate at the call site.
function isOrphanRowLabel(text) {
  if (!text) return false;
  if (!LETTER_RE.test(text)) return false;
  if (findCells(text).length !== 0) return false;
  if (/।\s*$/.test(text)) return false;
  if (/^\(.*\)$/.test(text.trim())) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 5;
}

// Inner text of a block that is a BARE <p>…</p> or <h3>…</h3>, else null.
// <h3> is accepted because a serial-led section divider ("१. सूचीकृत धितोपत्रमा
// लगानी") carries no figures, so classifyLine still routes it through
// isNumberedSection -> <h3>, and an <h3> would otherwise hard-break the run.
// Two deliberate exclusions:
//   * `<h3 style="text-align:center">` does NOT match — those come from the
//     strict CENTERED_HEADING_WHITELIST (तपसिल / वासलात / बोधार्थ) and are real
//     document headings that SHOULD break a table run.
//   * any inner "<" returns null — mirrors the <strong>/<em> reject in
//     looksLikeTableRow. Without it "<p><em>* अनुमानित</em></p>" would pass
//     isBridgeLabel and inject "&lt;em&gt;" into a <td>.
const BARE_BLOCK_RE = /^<(p|h3)>([\s\S]*)<\/\1>$/;
function bareBlockText(block) {
  const m = block.match(BARE_BLOCK_RE);
  if (!m) return null;
  if (m[2].includes("<")) return null;
  return m[2].trim();
}

// A section band that classifyLine promoted to a HEADING. "EQUITY AND
// LIABILITIES" is all-caps, so isEnglishCapsHeading claims it and emits
// <h2 style="text-align:center">, which BARE_BLOCK_RE deliberately excludes —
// so it reached detectFinancialTables' break arm and split the balance sheet in
// two. Consulted ONLY when the run is already WARM (data buffered): a heading
// arriving cold is still a real document heading and still starts a new table.
const HEADING_BLOCK_RE = /^<(h2|h3)(?:\s[^>]*)?>([\s\S]*)<\/\1>$/;
function headingBandText(block) {
  const m = block.match(HEADING_BLOCK_RE);
  if (!m) return null;
  if (m[2].includes("<")) return null;
  return unescapeBasic(m[2].trim());
}

// structureToHtml already ran escapeHtml over the line and flushBuffer escapes
// again — so "Profit & Loss Account" published as "&amp;amp;" and rendered
// literally. Undo once on extraction (exact inverse of escapeHtml, "&amp;" LAST).
function unescapeBasic(s) {
  return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Most common value in a list; ties resolve to the larger value.
function modeOf(nums) {
  const counts = new Map();
  for (const n of nums) counts.set(n, (counts.get(n) || 0) + 1);
  let best = nums[0], bestC = 0;
  for (const [n, c] of counts) if (c > bestC || (c === bestC && n > best)) { best = n; bestC = c; }
  return best;
}

// detectFinancialTables — second-pass over structureToHtml output that wraps
// runs of data-row blocks into <table>s. Three enhancements over the
// naive consecutive-run approach:
//
//   1. Cells/values are stored on each buffered entry so we can rebuild
//      proper <tr><td>...</td></tr> markup AND know each row's column
//      count (used to compute the divider colspan).
//
//   2. Single short label paragraphs between data rows are absorbed as
//      section-divider rows (`<tr><td colspan="N"><strong>...</strong></td></tr>`)
//      inside the table rather than breaking the run. Source PDF balance
//      sheets typically intersperse data rows with sub-section labels
//      ("गैर चालु सम्पत्ति", "चालु सम्पत्ति", "इक्विटी र दायित्व", etc.)
//      with no numeric values — without this bridging, those labels would
//      split one logical table into 3-4 small tables and leave many data
//      rows orphaned as plain <p>.
//
//   3. 2026-07-30 — buffer entries now come in THREE kinds:
//      'data' | 'divider' | 'header'. Dividers AND column-header rows are
//      tentative: they only survive inside the table if a data row follows
//      (otherwise they spill back verbatim, in source order, from one shared
//      queue). The first cleanly-splittable header becomes a real
//      <thead><tr><th scope="col">; every OTHER header becomes a divider row
//      (never deleted) except a byte-identical repeat, which is the same
//      header reprinted at a page break and is swallowed so the statement
//      stays ONE <table>. `cols` is the MODE of data-row widths (not the max,
//      which let one stray digit widen every row); a ragged table forfeits its
//      <thead> and logs to stderr, because a header is an assertion about
//      column identity we refuse to make over rows known to disagree. Minimum
//      run is 2 data rows, relaxed to 1 directly under a promoted header.
function detectFinancialTables(html) {
  const blocks = html.split(/\n/);
  const out = [];
  // Buffer / pending entries:
  //   { kind: 'data',    block, cells }
  //   { kind: 'divider', block, text, cold }
  //   { kind: 'header',  block, texts, text }   text = texts.join(' ')
  // `block` may hold SEVERAL source blocks joined by "\n" (a two-line header, a
  // wrapped label + its row, a label + its values line). `out` is joined on
  // "\n", so every spill path restores the original lines byte-for-byte — that
  // is what makes each merge reversible.
  // `cold` marks a divider that arrived with the run COLD: no data buffered and
  // no header pending. A cold divider immediately followed by a column header is
  // the statement TITLE, not a section band.
  let buffer = [];
  // Tentative entries (section dividers AND column-header rows) in source
  // order. Resolved by the NEXT block: a data row promotes them into the
  // table; anything else spills them back verbatim. ONE queue, because the
  // order between a divider and a header must be preserved. No cap on length —
  // balance sheets often have 5-7 consecutive sub-section labels.
  let pending = [];

  const normText = (s) => String(s).replace(/\s+/g, " ").trim();

  const commitDataRow = (cells, block) => {
    for (const p of pending) buffer.push(p);
    pending = [];
    buffer.push({ kind: "data", block, cells });
  };

  // Column count the open table is running at, or -1 when the run is too short
  // to have established one. Gates the D4 fusion: an ungated version fuses a
  // caption like "Assets:" onto the next values line and splits the table.
  const runningCols = () => {
    const w = buffer.filter((e) => e.kind === "data").map((e) => e.cells.length);
    return w.length >= 2 ? modeOf(w) : -1;
  };

  const flushBuffer = () => {
    // Pop ALL trailing non-data entries (a divider or header with no data row
    // after it) back out past the </table>.
    const trailing = [];
    while (buffer.length > 0 && buffer[buffer.length - 1].kind !== "data") {
      trailing.unshift(buffer.pop().block);
    }
    const dataEntries = buffer.filter((e) => e.kind === "data");
    if (dataEntries.length === 0) {
      for (const e of buffer) out.push(e.block);
      out.push(...trailing);
      buffer = [];
      return;
    }

    // Column count from the MODE of data-row widths, not the max: one stray
    // trailing digit on a single row must not widen every other row and
    // collapse the header alignment.
    const widths = dataEntries.map((e) => e.cells.length);
    const modeCols = modeOf(widths);
    const ragged = widths.some((w) => w !== modeCols);

    // ── D7 ── An over-wide row is usually a LABEL the cell scanner over-read:
    //   "५. आरबिबि म्युचुअल फण्ड - २ ६३८,००० ६,३८०,०००"
    // is the fund named "आरबिबि म्युचुअल फण्ड - २", not a 5-column row, but it
    // came out as [label, "-", "२", v1, v2]. Fold the surplus LEADING cells back
    // into the label — but ONLY when none of them is a financial figure. A
    // surplus carrying real money is a genuinely wider row and still widens the
    // table exactly as before. Matters now because D5 merges the portfolio grid
    // into ONE table: with cols = max, ~135 rows would be padded with empty <td>.
    const foldRow = (cells) => {
      const surplus = cells.length - modeCols;
      if (surplus <= 0) return cells;
      const head = cells.slice(1, surplus + 1);
      if (head.some((c) => isFinancialNumeric(c))) return null;
      return [cells.slice(0, surplus + 1).join(" ").trim(), ...cells.slice(surplus + 1)];
    };
    const foldable = dataEntries.every(
      (e) => e.cells.length <= modeCols || foldRow(e.cells) !== null
    );
    const cols = ragged && !foldable ? Math.max(...widths) : modeCols;
    if (ragged) {
      for (const e of dataEntries) {
        if (e.cells.length !== modeCols) {
          process.stderr.write(
            `      [detectFinancialTables] row has ${e.cells.length} cells, ` +
              `table mode is ${modeCols}: ${e.cells.join(" | ").substring(0, 120)}\n`
          );
        }
      }
    }

    // First header anywhere in the buffer (NOT buffer[0] — a divider is often
    // promoted ahead of it). Promoted to <thead> only if it splits cleanly
    // into `cols` labels AND the rows are uniform.
    const headerIdx = buffer.findIndex((e) => e.kind === "header");
    const headerEntry = headerIdx >= 0 ? buffer[headerIdx] : null;
    const headerAdjacent =
      headerEntry && buffer[headerIdx + 1] && buffer[headerIdx + 1].kind === "data";
    // 2026-08-04: this used to require !ragged, which threw the header away for
    // the whole table whenever ONE row was short — "Capital Fund to RWA - -"
    // (3 cells) in a 5-column statement cost post 5637 every <thead> it had.
    // Short rows are padded, never truncated, so they cannot push a column label
    // over the wrong figure. Only a row WIDER than `cols` could, and none can
    // exist here: cols is either the max width or the folded mode width, so the
    // check is against the width each row will actually RENDER at.
    const renderWidth = (e) => {
      let cs = e.cells;
      if (cols === modeCols) cs = foldRow(cs) || cs;
      return cs.length;
    };
    const overWide = dataEntries.some((e) => renderWidth(e) > cols);
    const theadCells =
      headerEntry && !overWide ? headerCells(headerEntry.texts, cols) : null;

    // A confirmed, adjacent, splittable header is strong evidence of a table,
    // so ONE data row under it is enough — this rescues the isolated
    // "शेयर २९४,२८९,३८३.७० ३०९,३०५,३३६.८०" row that sat alone between two
    // section headings. Otherwise the 2-row minimum stands unchanged.
    const minRows = theadCells && headerAdjacent ? 1 : 2;
    if (dataEntries.length < minRows) {
      for (const e of buffer) out.push(e.block);
      out.push(...trailing);
      buffer = [];
      return;
    }

    const norm = normText;
    const bodyEntries = [];
    buffer.forEach((e, idx) => {
      if (e.kind === "header") {
        if (theadCells && idx === headerIdx) return;                    // hoisted to <thead>
        // A byte-identical repeat is the same header reprinted at a page
        // break — safe to swallow ONLY because !ragged proves the rows on
        // both sides have the same column count. Any other header text is
        // preserved as a divider row; a header is never silently deleted.
        // Gated on the header being DIGIT-FREE so a swallow can never delete a
        // figure: post 5571's header carries "२०८३" twice per printed line and
        // reprints 4x — swallowing it would cost 24 Devanagari digits. A
        // digit-bearing repeat is kept as a divider row instead.
        if (theadCells &&
            norm(e.text) === norm(headerEntry.text) &&
            !/[0-9०-९]/.test(e.text)) return;
        bodyEntries.push({ kind: "divider", block: e.block, text: e.text });
        return;
      }
      bodyEntries.push(e);
    });

    const rows = bodyEntries.map((e) => {
      if (e.kind === "data") {
        let cs = e.cells.slice();
        if (cols === modeCols) cs = foldRow(cs) || cs;   // D7 — never truncates
        while (cs.length < cols) cs.push("");            // pad only; never truncate
        return `<tr>${cs.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`;
      }
      return `<tr><td colspan="${cols}"><strong>${escapeHtml(e.text)}</strong></td></tr>`;
    });
    const thead = theadCells
      ? `<thead><tr>${theadCells
          .map((c) => `<th scope="col">${escapeHtml(c)}</th>`)
          .join("")}</tr></thead>`
      : "";
    out.push(`<table>${thead}<tbody>${rows.join("")}</tbody></table>`);
    out.push(...trailing);
    buffer = [];
  };

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (!block.trim()) continue;
    const bare = bareBlockText(block);
    const text = unescapeBasic(bare !== null ? bare : block.replace(/^<p>|<\/p>$/g, "").trim());

    // ── D4 ── Label line + values-only line -> ONE data row. One-block
    // lookahead (only whitespace-blank blocks are skipped, so `bi = nj` is
    // safe). The fusion REPLACES two source blocks with one row, so it is
    // irreversible — acceptable only because runningCols() guarantees >= 2 data
    // rows are already buffered, i.e. flushBuffer's give-up spill is
    // unreachable. Do not relax that gate without carrying both original blocks.
    // !isBridgeLabelLoose keeps every real section band out.
    if (bare !== null && isOrphanRowLabel(text) && !isBridgeLabelLoose(text)) {
      let nj = bi + 1;
      while (nj < blocks.length && !blocks[nj].trim()) nj++;
      const nb = nj < blocks.length ? blocks[nj] : null;
      const nbare = nb !== null ? bareBlockText(nb) : null;
      const ntext = nbare !== null ? unescapeBasic(nbare) : null;
      if (ntext !== null && isValuesOnlyLine(ntext)) {
        const fused = `${text} ${ntext}`.replace(/\s+/g, " ").trim();
        const cells = looksLikeDataRowText(fused) ? tableRowFromText(fused) : null;
        if (cells && cells.length === runningCols()) {
          commitDataRow(cells, `${block}\n${nb}`);
          bi = nj;
          continue;
        }
      }
      // No values successor (or no open table) -> fall through and take exactly
      // the branch this line took before the fix.
    }

    const tail = pending[pending.length - 1];
    const openHeader =
      tail && tail.kind === "header" && tail.texts.length === 1 ? tail : null;

    // A line the header test accepts can NEVER be a data row: isTableHeaderRowLine
    // rejects anything carrying a financial numeric, so the only digits it can
    // hold are bare years. "Particulars Quarter End Ashad 2083 2082 2082"
    // (post 5632) satisfied looksLikeTableRow on those three years and was
    // committed as a data ROW, leaving both its tables header-less.
    const headerWins = bare !== null && isTableHeaderRowLine(text);

    if (looksLikeTableRow(block, text) && !headerWins) {
      // Confirmed data row — absorb the whole tentative queue in source order,
      // then add the row.
      let cells = tableRowFromText(text) || [text];
      let rowBlock = block;
      // ── D3 ── the tentative divider directly above may be this row's own
      // wrapped label. Only cells[0] changes, never the cell COUNT, so this can
      // never make a table ragged. BOTH source blocks ride on the entry, so the
      // fragment (and its serial digit) survives flushBuffer's spill paths.
      if (tail && tail.kind === "divider" && isWrappedLabelFragment(tail.text, cells[0])) {
        pending.pop();
        cells = [`${tail.text} ${cells[0]}`.trim(), ...cells.slice(1)];
        rowBlock = `${tail.block}\n${block}`;
      }
      commitDataRow(cells, rowBlock);

    } else if (
      openHeader &&
      bare !== null &&
      (isHeaderUnitContinuationLine(text) || isHeaderSubLabelLine(text))
    ) {
      // ── D1 ── unit row of a two-printed-line header: attach, do not break.
      openHeader.texts.push(text);
      openHeader.text = openHeader.texts.join(" ");
      openHeader.block = `${openHeader.block}\n${block}`;

    } else if (bare !== null && isTableHeaderRowLine(text)) {
      // A header whose FIRST printed line repeats one already inside the open
      // table is the same column header reprinted at the top of the next boxed
      // section. When a caption/band arrived since the last data row, CLOSE the
      // current table and open a new one: `pending` carries over, so the caption
      // becomes the new table's first body row and the new section gets its own
      // <thead>. Nothing is swallowed, so no digit is lost, and the reader never
      // sees a duplicate header rendered as a full-width band. Compare on
      // texts[0] because the continuation has not arrived yet.
      const repeat = buffer.some(
        (e) => e.kind === "header" && normText(e.texts[0]) === normText(text)
      );
      if (repeat && pending.length > 0) flushBuffer();
      // A COLD divider immediately followed by a column header is the statement
      // TITLE ("खुद् सम्पत्ति मूल्य सम्बन्धी विवरण"), not a section band — spill it so
      // it stays a <p> OUTSIDE the table. Safe to emit now: cold means no data
      // was buffered when it arrived, and a data row would have drained pending.
      // Section bands are unaffected: they arrive AFTER a header is pending
      // (धितोपत्रमा लगानी) or after a data row (चालु सम्पत्ति / चालु दायित्व).
      while (pending.length > 0 && pending[0].kind === "divider" && pending[0].cold) {
        out.push(pending.shift().block);
      }
      pending.push({ kind: "header", block, texts: [text], text });

    } else if (bare !== null && isBridgeLabelLoose(text)) {
      const cold =
        !buffer.some((e) => e.kind === "data") &&
        !pending.some((e) => e.kind === "header");
      pending.push({ kind: "divider", block, text, cold });

    } else if (
      bare === null &&
      buffer.some((e) => e.kind === "data") &&
      isBridgeLabelLoose(headingBandText(block) || "")
    ) {
      // A short section band that came through as a HEADING, mid-table. `block`
      // is the original heading markup, so every spill path still restores it
      // byte-for-byte; only the <td colspan> rendering uses the extracted text.
      pending.push({ kind: "divider", block, text: headingBandText(block), cold: false });

    } else {
      // Real break in the table run.
      flushBuffer();
      for (const p of pending) out.push(p.block);
      pending = [];
      out.push(block);
    }
  }
  // End of input — flush remaining buffer + any trailing tentative entries.
  flushBuffer();
  for (const p of pending) out.push(p.block);
  pending = [];

  return out.join("\n");
}

// ─── Build the news payload ───
function buildAnnouncement(detail, cleanedOcr, generated = {}) {
  const pageTitle = detail.title || "";
  const rawSummary = (detail.summaryText || "").trim();
  // tags[0] = 'Announcement' (primary identifier — homepage filter + card badge).
  // tags[1] = ShareSansar category if available, so the article page can display
  // it as the notice's subtype (e.g. "AGM/Special AGM", "IPO/FPO News",
  // "Financial Analysis"). Falls back to single-tag array if no category.
  const tags = [ANNOUNCEMENT_TAG];
  if (detail.category && detail.category.trim()) {
    tags.push(detail.category.trim());
  }

  // Gemini-generated concise headlines (preferred over the verbose ShareSansar
  // H1). Fall back to the page title if Gemini didn't return one or returned
  // something obviously bad (empty, too long, identical to the verbose source).
  const gNp = (generated.shortTitleNp || "").trim();
  const gEn = (generated.shortTitleEn || "").trim();
  const englishTitle =
    gEn && gEn.length >= 10 && gEn.length <= 140 ? gEn : pageTitle;
  const nepaliTitle =
    gNp && gNp.length >= 10 && gNp.length <= 140 ? gNp : pageTitle;

  // English content/summary — Gemini's translation of the Nepali body.
  // Same structureToHtml + detectFinancialTables pipeline runs over it
  // so the article body looks identical structurally on the lang=en page
  // (numbered <ol>, <table>, centered <h3> headings all carry through).
  // When Gemini's translation is missing/empty (older items or rare parse
  // failure), fall back to: ShareSansar's English detail summary (if it
  // isn't just a title duplicate), then empty.
  const cleanedEn = (generated.cleanedEn || "").trim();
  const englishContent = cleanedEn
    ? detectFinancialTables(structureToHtml(cleanedEn))
    : "";
  const englishSummary = cleanedEn
    ? deriveSummary(cleanedEn)
    : looksLikeTitleDuplicate(rawSummary, pageTitle)
      ? ""
      : rawSummary;

  // Auto-resolved thumbnail URL — points to the appropriate category image
  // on the production frontend. The admin "Manage News" panel reads this
  // field directly and shows the image inline; the live announcement detail
  // page also uses it (per-item thumbnail wins over the helper's category
  // fallback). Empty string is acceptable: the frontend helper still kicks
  // in at render time and serves the category image via its own logic.
  return {
    author_name: "NEPSE Trading",
    tags,
    thumbnail_url: resolveCategoryImageUrl(detail.category),
    _internal_category: detail.category || "",
    _internal_source_url: detail._sourceUrl || "",
    english_title: englishTitle,
    english_summary: englishSummary,
    english_content: englishContent,
    nepali_title: nepaliTitle,
    nepali_summary: deriveSummary(cleanedOcr),
    nepali_content: detectFinancialTables(structureToHtml(cleanedOcr)),
  };
}

// ─── Category blacklist ───
// Skip notices whose ShareSansar category is in this set BEFORE doing any
// expensive work (image download, Gemini OCR). These categories are either
// non-corporate content (interviews, video tutorials), meta tags (recommended,
// premium), or too generic to be useful as discrete announcement entries.
// Categories NOT in this set are treated as legitimate corporate filings.
//
// Case-insensitive match against the value of detail.category (the
// ShareSansar category tag on the detail page).
const CATEGORY_BLACKLIST = new Set(
  [
    // Meta / aggregator categories (not real corporate content)
    "Recommended",
    "Premium",
    "External Media",
    // Generic catch-alls (overlap with more specific categories)
    "Corporate",
    // Content categories (interviews/tutorials are produced content, not filings)
    "Interview",
    "Video Tutorials",
    // NOTE: "Others" used to be blacklisted but was removed because
    // ShareSansar routinely tags legitimate regulatory notices as Others
    // when none of their narrower category labels fit (e.g. bank PAN-update
    // reminders, insurance-related notices, promoter-share conversion
    // announcements). The dedup pass + frontend category-image fallback
    // (default.png when no Others-specific image is shipped) handle these
    // gracefully.
  ].map((s) => s.toLowerCase())
);

function isCategoryBlacklisted(category) {
  if (!category) return false;
  return CATEGORY_BLACKLIST.has(String(category).trim().toLowerCase());
}

async function fetchAndProcessOne(item, indexLabel) {
  // Source-URL cache gate — bail BEFORE the detail fetch + Gemini OCR if
  // we've already successfully posted this ShareSansar URL. Saves both
  // bandwidth (skip detail page fetch) and Gemini API quota (skip OCR).
  // This is the primary dedup mechanism; title-fingerprint in auto-post is
  // the secondary safety net for items posted before we tracked URLs.
  //
  // `--url=` is an EXPLICIT single-URL request (re-OCR / backfill / fixing a
  // bad post), so it intentionally bypasses this skip — otherwise you could
  // never re-process a URL that's already in the cache. The URL stays cached,
  // so the normal daily runs still won't duplicate it.
  if (item.url && POSTED_URLS_CACHE.has(item.url) && !cliUrl) {
    const err = new Error(`already posted (source URL in cache): ${item.url}`);
    err.skipped = true;
    throw err;
  }

  const detailRes = await fetch(item.url, { headers: BROWSER_HEADERS });
  if (!detailRes.ok) throw new Error(`detail page status ${detailRes.status}`);
  const detailHtml = await detailRes.text();
  const detail = parseDetailPage(detailHtml, item.title);
  // Stamp the source URL onto detail so buildAnnouncement can include it
  // as `_internal_source_url` in the output JSON (consumed by auto-post
  // for the post-success cache update).
  detail._sourceUrl = item.url || "";

  // Blacklist gate — bail BEFORE the Gemini OCR call so we don't burn API
  // quota on items we're going to throw away. The .skipped flag tells main()
  // to log this as a skip instead of a failure.
  if (isCategoryBlacklisted(detail.category)) {
    const err = new Error(`blacklisted category: ${detail.category}`);
    err.skipped = true;
    throw err;
  }

  if (!detail.image) throw new Error("no notice image found on detail page");

  const imgRes = await fetch(detail.image, { headers: { "User-Agent": UA } });
  if (!imgRes.ok) throw new Error(`image fetch ${imgRes.status}`);
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());

  // Try the response Content-Type first; fall back to URL-extension detection.
  const respContentType = (imgRes.headers.get("content-type") || "").split(";")[0].trim();
  const mediaType = respContentType.startsWith("image/")
    ? respContentType
    : detectImageMimeType(detail.image);

  // OCR via Google Gemini Vision — returns {content, contentEn,
  // shortTitleNp, shortTitleEn}. The category is passed in so ocrViaGemini
  // can pick the higher-accuracy model for Financial Analysis notices.
  // cleanOcrText still applies as a defensive second pass (letterhead
  // trim, footnote filter, leading-pipe scrub) for the Nepali content,
  // and the same pass runs over the English translation so the
  // article-body formatter sees consistent input for both languages.
  const ocrResult = await ocrViaGemini(imgBuf, indexLabel, mediaType, detail.category);
  const cleanedNp = cleanOcrText(ocrResult.content);
  const cleanedEn = ocrResult.contentEn ? cleanOcrText(ocrResult.contentEn) : "";

  return buildAnnouncement(detail, cleanedNp, {
    cleanedEn,
    shortTitleNp: ocrResult.shortTitleNp,
    shortTitleEn: ocrResult.shortTitleEn,
  });
}

// ─── Main ───
async function main() {
  // Offline classification harness — must run BEFORE anything that touches the
  // network, the readline prompt or the Gemini keys.
  if (cliClassify) {
    const raw = fs.readFileSync(cliClassify, "utf8");
    const cleaned = cleanOcrText(raw);
    for (const l of cleaned.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 1)) {
      // H = isTableHeaderRowLine, D = looksLikeDataRowText. Lets the corpus
      // audit tell a table that has NO header in the SOURCE (correctly
      // header-less) apart from one whose header was missed.
      const mark =
        (isTableHeaderRowLine(l) ? "H" : "-") + (looksLikeDataRowText(l) ? "D" : "-");
      console.log(`${mark} ${classifyLine(l).padEnd(18)}| ${l}`);
    }
    console.log("\n--- HTML ---\n" + detectFinancialTables(structureToHtml(cleaned)));
    closeRL();
    return;
  }

  console.log("\nShareSansar Announcements pipeline (Gemini Vision OCR)\n");

  if (isDryRun) {
    console.log("DRY RUN: fetching ONE announcement, printing assembled JSON, NOT writing to disk.\n");
    closeRL();

    let item;
    if (cliUrl) {
      // --url=... fast-path: skip the list scan and synthesise an item.
      // fetchAndProcessOne uses item.url for the detail fetch and item.title
      // only as a fallback when the detail page lacks an H1, so a bare title
      // here is fine — it gets overridden by the actual notice title.
      item = { url: cliUrl, title: "(from --url)", date: "" };
      console.log(`Direct URL: ${item.url}\n`);
    } else {
      // Use pagination-aware fetcher to handle --skip past page 1 (page 1
      // only has ~15-20 items; if --skip=20 we need to read page 2 too).
      const allItems = await fetchAnnouncementList(cliSkip + 1);
      if (allItems.length === 0) {
        console.error("No announcements parsed from list page (HTML structure may have changed).");
        process.exit(1);
      }
      if (allItems.length <= cliSkip) {
        console.error(
          `--skip=${cliSkip} but only ${allItems.length} announcement(s) available on the list page.`
        );
        process.exit(1);
      }
      item = allItems[cliSkip];
      const indexLabel = cliSkip > 0 ? `announcement #${cliSkip + 1}` : "First announcement";
      console.log(`${indexLabel}: ${item.title}`);
      console.log(`URL: ${item.url}\n`);
    }

    try {
      const result = await fetchAndProcessOne(item, "[1/1]");
      console.log("\n" + "=".repeat(72));
      console.log("ASSEMBLED JSON:");
      console.log("=".repeat(72));
      console.log(JSON.stringify(result, null, 2));
      console.log("=".repeat(72));
      console.log("\nDRY RUN COMPLETE. Nothing written to disk.\n");
    } catch (e) {
      if (e && e.skipped) {
        console.log(`\nSkipped: ${e.message}`);
        console.log("DRY RUN COMPLETE (item filtered by category blacklist).");
      } else {
        console.error(`\nFailed: ${e.message}`);
        process.exit(1);
      }
    }
    return;
  }

  // --url= fast-path: skip the list scan and process a single targeted
  // notice. Writes the result to news-announcements.json so the standard
  // batch-post-news.js workflow can publish it. Useful for backfilling
  // a notice that's already aged off the front of the list page.
  let items;
  if (cliUrl) {
    closeRL();
    items = [{ url: cliUrl, title: "(from --url)", date: "" }];
    console.log(`\nDirect URL: ${cliUrl}\n`);
  } else {
    let count;
    if (cliCount !== null) {
      if (cliCount < 1 || cliCount > MAX_COUNT) {
        console.error(`--count must be between 1 and ${MAX_COUNT}`);
        process.exit(1);
      }
      count = cliCount;
    } else {
      count = await askCount();
    }
    closeRL();

    console.log(`\nFetching announcement list from ${LIST_URL} (paginated up to ${count + cliSkip} items)...`);
    // Paginated fetch — walks pages until we hit count+cliSkip items OR a page
    // returns nothing new. This is the key change vs. the old single-page
    // fetch: high counts (e.g. 30 in the catch-up runs after a window gap)
    // now actually return 30 items by reading pages 1 and 2.
    const fullList = await fetchAnnouncementList(count + cliSkip);
    if (fullList.length === 0) {
      console.error("No announcements parsed (HTML structure may have changed, or all pages returned empty).");
      process.exit(1);
    }
    if (fullList.length <= cliSkip) {
      console.error(
        `--skip=${cliSkip} but only ${fullList.length} announcement(s) available on the list page.`
      );
      process.exit(1);
    }
    items = fullList.slice(cliSkip);
    if (cliSkip > 0) {
      console.log(`Skipping first ${cliSkip} announcement(s).`);
    }
    console.log(`Found ${items.length} announcement(s) to process.\n`);
  }

  const news = [];
  const failures = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const label = `[${i + 1}/${items.length}]`;
    console.log(`${label} ${it.title.substring(0, 80)}`);
    try {
      const result = await fetchAndProcessOne(it, label);
      // A notice whose English body came back empty while the Nepali body did
      // not is a TRUNCATED response, not a translation-free notice — the pipeline
      // always generates both. Publishing it yields an article with a blank
      // English tab, and because the source URL is then cached as posted it is
      // never retried. Fail it instead so the next run picks it up.
      const npLen = String(result.nepali_content || "").length;
      const enLen = String(result.english_content || "").length;
      if (npLen > 0 && enLen === 0) {
        throw new Error(
          `English body empty (nepali=${npLen} chars) — truncated response, not publishing`
        );
      }
      news.push(result);
      console.log(`${label} OK\n`);
    } catch (e) {
      if (e && e.skipped) {
        console.log(`${label} skipped (${e.message})\n`);
      } else {
        // A skip is a DECISION (duplicate, outside the age window); a FAILURE is
        // an item the reader should have received and did not. On 2026-09-01 all
        // three of the day's announcements died on "Gemini 503: model is
        // currently experiencing high demand" and the run still exited 0 — Task
        // Scheduler logged result=0 and nothing ever surfaced.
        failures.push({ title: it.title, url: it.url, error: String(e.message || e) });
        console.log(`${label} FAILED: ${e.message}\n`);
      }
    }
    if (i < items.length - 1) {
      await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(news, null, 2), "utf-8");
  // Always rewritten, so a clean run clears the previous run's failures.
  fs.writeFileSync(FAILURES_FILE, JSON.stringify(failures, null, 2), "utf-8");
  if (failures.length > 0) {
    console.log(
      `${failures.length} item(s) FAILED and were not written — recorded in ` +
        `${path.basename(FAILURES_FILE)}`
    );
  }
  console.log(`${news.length} item(s) written to ${path.basename(OUTPUT_FILE)}`);
  console.log(`Next: node batch-post-news.js --file=${path.basename(OUTPUT_FILE)}\n`);
}

main().catch((e) => {
  console.error("\nFatal error:", e.message);
  process.exit(1);
});
