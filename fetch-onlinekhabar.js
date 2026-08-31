// fetch-onlinekhabar.js
// Scrapes OnlineKhabar (Nepali) and english.onlinekhabar.com (English) via RSS.
// Writes into news-onlinekhabar.json — a queue consumed by batch-post-news.js:
//     node batch-post-news.js --file=news-onlinekhabar.json
//
// Modes:
//   node fetch-onlinekhabar.js           → one-shot batch (interactive prompts)
//   node fetch-onlinekhabar.js --watch   → live daemon, polls every 60s,
//                                          watch-only: ignores backlog,
//                                          only queues items published AFTER launch
//   node fetch-onlinekhabar.js --reset   → clear the queue file (seen state preserved)
//
// State files (gitignore both):
//   news-onlinekhabar.json   the queue (array, appended to)
//   seen-onlinekhabar.json   { guids: [...], updatedAt: "..." }   dedup tracking

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ─── Config ───
const NEPALI_FEED = "https://onlinekhabar.com/feed";
const ENGLISH_FEED = "https://english.onlinekhabar.com/feed";
const QUEUE_FILE = path.join(__dirname, "news-onlinekhabar.json");
const SEEN_FILE = path.join(__dirname, "seen-onlinekhabar.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const NPT_OFFSET_MS = (5 * 60 + 45) * 60 * 1000; // Nepal Time = UTC + 5h45m
const POLL_INTERVAL_MS = 60 * 1000;
const DETAIL_FETCH_DELAY_MS = 250;
const MAX_RSS_PAGES = 10; // safety cap so we don't paginate forever

// Rewriter (Gemini text-only). Defaults to flash-lite for the higher 15 RPM free-tier cap.
const REWRITE_MODEL = (process.env.REWRITE_MODEL || "gemini-2.5-flash-lite").trim();
const REWRITE_DELAY_MS = 4500; // 15 RPM ≈ one call every 4s; 4.5s gives a margin

// ─── CLI args ───
const args = process.argv.slice(2);
const isWatch = args.includes("--watch");
const isReset = args.includes("--reset");

// ─── Readline (single shared) ───
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

// ─── Interactive prompts ───
async function askLanguage() {
  while (true) {
    console.log("\n🌐 Language:");
    console.log("   1) Nepali (onlinekhabar.com)");
    console.log("   2) English (english.onlinekhabar.com)");
    const a = await prompt("Choose (1/2, default 1): ");
    if (!a || a === "1") return "nepali";
    if (a === "2") return "english";
    console.log("   ⚠️  Enter 1 or 2");
  }
}

async function askCutoff() {
  const a = await prompt(
    "\n⏰ Time cutoff — only items published after HH:MM Nepal Time today (default 15:50): "
  );
  const s = a.trim() || "15:50";
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    console.log("   ⚠️  Invalid format, using 15:50");
    return cutoffFromNptClock(15, 50);
  }
  return cutoffFromNptClock(parseInt(m[1], 10), parseInt(m[2], 10));
}

async function askCount() {
  while (true) {
    const a = await prompt("📊 Max items to fetch (default 250): ");
    if (!a) return 250;
    const n = parseInt(a, 10);
    if (!isNaN(n) && n >= 1 && n <= 1000) return n;
    console.log("   ⚠️  Enter a number between 1 and 1000");
  }
}

async function askRewriter() {
  const a = (await prompt(
    "\n✏️  Rephrase scraped articles via Gemini (~4.5s per item, free tier)? (y/N): "
  )).toLowerCase();
  return a === "y" || a === "yes";
}

// Compute the UTC Date for "today HH:MM Nepal Time"
function cutoffFromNptClock(hh, mm) {
  const now = Date.now();
  const nptNow = new Date(now + NPT_OFFSET_MS);
  const y = nptNow.getUTCFullYear();
  const mo = nptNow.getUTCMonth();
  const d = nptNow.getUTCDate();
  const cutoffUtcMs = Date.UTC(y, mo, d, hh, mm, 0) - NPT_OFFSET_MS;
  return new Date(cutoffUtcMs);
}

// ─── HTML / entity helpers ───
function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&#8230;/g, "…")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#8216;|&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"');
}

function stripTags(html) {
  return decodeEntities(
    (html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function extractCdata(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  const inner = m[1];
  const cdataMatch = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return cdataMatch ? cdataMatch[1] : inner;
}

// ─── RSS parsing ───
// Returns array of { guid, title, link, pubDate (Date), categories, image, contentEncoded, description }
function parseRssItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];

    const guidMatch = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const guid = guidMatch ? decodeEntities(stripTags(guidMatch[1])) : "";

    const title = decodeEntities(extractCdata(block, "title") || stripTags(extractCdata(block, "title")));
    const link = decodeEntities(stripTags(extractCdata(block, "link")));

    const pubRaw = stripTags(extractCdata(block, "pubDate"));
    const pubDate = pubRaw ? new Date(pubRaw) : null;

    // categories: zero or more
    const cats = [];
    const catRe = /<category[^>]*>([\s\S]*?)<\/category>/g;
    let cm;
    while ((cm = catRe.exec(block))) {
      const c = decodeEntities(stripTags(cm[1].replace(/<!\[CDATA\[|\]\]>/g, "")));
      if (c) cats.push(c);
    }

    // image: <image>URL</image> tag at item level OR first <img src> in content:encoded
    let image = "";
    const imgTag = block.match(/<image>([\s\S]*?)<\/image>/);
    if (imgTag) image = decodeEntities(stripTags(imgTag[1]));

    const contentEncoded = extractCdata(block, "content:encoded");
    const description = extractCdata(block, "description");

    if (!image && contentEncoded) {
      const imgMatch = contentEncoded.match(/<img[^>]+src=["']([^"']+)["']/);
      if (imgMatch) image = imgMatch[1];
    }

    if (!guid || !link) continue;
    items.push({ guid, title: stripTags(title), link, pubDate, categories: cats, image, contentEncoded, description });
  }
  return items;
}

// Fetch up to maxPages from a base feed URL, stopping when items are older than cutoff
async function fetchRssPages(baseUrl, { cutoff, maxItems, maxPages = MAX_RSS_PAGES }) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = baseUrl + (page === 1 ? "" : "?paged=" + page);
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) {
      console.log(`   ⚠️  RSS page ${page} returned ${r.status} — stopping pagination`);
      break;
    }
    const xml = await r.text();
    const items = parseRssItems(xml);
    if (items.length === 0) break;
    for (const it of items) {
      if (cutoff && it.pubDate && it.pubDate < cutoff) {
        return out; // any further items will be older still — done
      }
      out.push(it);
      if (maxItems && out.length >= maxItems) return out;
    }
    // Heuristic: if every item on this page was kept and we still want more, fetch next page
  }
  return out;
}

// ─── Detail page body extraction (Nepali only) ───
const NEPALI_SKIP_PREFIXES = [
  /^News Summary Generated by OK AI/i,
  /^Editorially reviewed/i,
];
const NEPALI_SIDEBAR_BLEED = [
  /\b(House|Land|Apartment|Bungalow|Flat|Room|Shop)\s+(for|to)\s+(Sale|Rent|Lease)\b/i,
  /\bRs\.?\s*\d[\d,]*\s+(Lac|Cr|Crore|Lakh)\b/i,
  /^Trending\.?\.?$/i,
];
// OnlineKhabar's emoji-reaction widget labels (Happy / Sad / Surprised / Excited / Angry).
// They live inside an ok-post-emoji div; this is a belt-and-suspenders filter in case
// the slice-end detection misses the widget.
const NEPALI_REACTION_WORDS = /^(खुसी|दुःखी|अचम्मित|उत्साहित|आक्रोशित)\s*$/;

// Regex for the article body opener. Matches either:
//   - <div class="entry-content ..."> — standard news template
//   - <div class="okv4-post-content ..."> — opinion / feature / v4 template
// Both are used by OnlineKhabar depending on content type.
const ENTRY_CONTENT_OPEN_RE =
  /<div\b[^>]*\bclass=["'][^"']*\b(?:entry-content|okv4-post-content)\b[^"']*["'][^>]*>/i;

// Markers that reliably come AFTER the article body. Pick the earliest one
// to cut the slice tight and avoid sidebar / reaction-widget / tag-row bleed.
const NEPALI_END_MARKERS = [
  "<!-- .entry-content -->",
  '<div class="ok-post-emoji',
  '<div class="ok-news-tags',
  '<div class="single-after-content',
  '<div class="ok-post-social-shares',
  '<footer class="entry-footer',
];

function isJunkParagraph(text) {
  if (!text) return true;
  if (NEPALI_REACTION_WORDS.test(text)) return true;
  for (const r of NEPALI_SKIP_PREFIXES) if (r.test(text)) return true;
  for (const r of NEPALI_SIDEBAR_BLEED) if (r.test(text)) return true;
  return false;
}

function extractOgImage(html) {
  // OnlineKhabar uses standard OG meta tags. Property may use either quote style
  // and attribute order varies, so handle both orderings.
  const m1 = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (m1) return m1[1];
  const m2 = html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
  if (m2) return m2[1];
  return "";
}

// Returns { bodyHtml, ogImage }. ogImage is "" if no og:image meta was present.
async function fetchNepaliBody(articleUrl) {
  const r = await fetch(articleUrl, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`detail fetch ${r.status}`);
  const html = await r.text();

  const ogImage = extractOgImage(html);

  const openMatch = html.match(ENTRY_CONTENT_OPEN_RE);
  if (!openMatch) return { bodyHtml: "", ogImage };
  const startIdx = openMatch.index + openMatch[0].length;

  // Find the earliest end marker after startIdx
  let endIdx = -1;
  for (const marker of NEPALI_END_MARKERS) {
    const idx = html.indexOf(marker, startIdx);
    if (idx > 0 && (endIdx < 0 || idx < endIdx)) endIdx = idx;
  }
  const slice = html.substring(startIdx, endIdx > 0 ? endIdx : startIdx + 80000);

  const paragraphs = [];
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(slice))) {
    const text = stripTags(m[1]);
    if (isJunkParagraph(text)) continue;
    paragraphs.push("<p>" + text + "</p>");
  }
  return { bodyHtml: paragraphs.join("\n"), ogImage };
}

// ─── English content cleanup ───
// Strip the "The post X appeared first on OnlineKhabar English News." trailer
// and turn raw content:encoded into a clean HTML string of <p> tags.
function cleanEnglishContent(html) {
  if (!html) return "";
  // Remove the "appeared first on" attribution paragraph the WordPress feed appends.
  const cleaned = html.replace(
    /<p>\s*The post\s+[\s\S]*?appeared first on[\s\S]*?<\/p>\s*$/i,
    ""
  );

  const paragraphs = [];
  // Pull <p> blocks plus retain inline figure captions as plain paragraphs
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(cleaned))) {
    const text = stripTags(m[1]);
    if (!text) continue;
    if (/appeared first on/i.test(text)) continue;
    paragraphs.push("<p>" + text + "</p>");
  }
  return paragraphs.join("\n");
}

function makeSummary(text, maxLen = 220) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  return t.substring(0, maxLen - 1).replace(/\s+\S*$/, "") + "…";
}

// ─── Gemini key loader (shared file with fetch-news.js for convenience) ───
function getGeminiKeySync() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const keyFile = path.join(__dirname, ".gemini-key");
  if (fs.existsSync(keyFile)) {
    const tok = fs.readFileSync(keyFile, "utf-8").trim();
    if (tok) return tok;
  }
  return null;
}
async function getGeminiKey() {
  const existing = getGeminiKeySync();
  if (existing) {
    console.log("🔑 Using Gemini key from .gemini-key file / env");
    return existing;
  }
  console.log(
    "   Get a free key at https://aistudio.google.com/apikey (no billing required)"
  );
  const answer = await prompt("🔑 Paste your Gemini API key: ");
  const tok = answer.trim();
  if (!tok) return null;
  fs.writeFileSync(path.join(__dirname, ".gemini-key"), tok, "utf-8");
  console.log("   Saved to .gemini-key for next run");
  return tok;
}

// ─── Defensive JSON parser for model responses ───
function extractJsonFromModelText(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(candidate.substring(first, last + 1));
  } catch {
    return null;
  }
}

function isTransientStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// ─── Rewriter (Gemini text-only) ───
function buildRewritePrompt({ title, summary, paragraphs, langMode }) {
  const langName = langMode === "nepali" ? "Nepali (Devanagari script)" : "English";
  const numeralNote =
    langMode === "nepali"
      ? "Both Devanagari (०१२३४५६७८९) and Arabic (0123456789) numerals appear in Nepali text — preserve exactly as written in the original."
      : "Preserve all numbers exactly as written.";

  return `You are rewriting a news article. The original language is ${langName}. Your output MUST be in the SAME language as the input.

STRICT RULES:
- Preserve EXACTLY: names of people, organizations, places, dates, numbers, percentages, currency figures, and any text inside quotes. Do NOT translate proper nouns. Do NOT normalize spellings.
- ${numeralNote}
- Do NOT add information that is not in the original. Do NOT infer, speculate, or fill in context. Do NOT remove information.
- Restructure sentences and use synonyms where natural in ${langName}. The wording should differ from the original but the meaning must be identical.
- Keep approximately the same paragraph count and per-paragraph length.
- No emojis.
- No source attribution. Do not mention OnlineKhabar.

Original title:
${title}

Original summary:
${summary}

Original paragraphs (in order, one per line, [P#] is just a marker):
${paragraphs.map((p, i) => `[P${i + 1}] ${p}`).join("\n")}

Return ONLY this JSON object, no prose, no code fences:
{
  "title": "rephrased title",
  "summary": "rephrased 1-2 sentence summary",
  "content_paragraphs": ["rephrased P1", "rephrased P2", ...]
}`;
}

async function callGeminiTextOnce({ apiKey, model, promptText }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        response_mime_type: "application/json",
        temperature: 0.5,
        // 8192 gives headroom for long Nepali (Devanagari) articles which encode
        // less densely than ASCII. Both 2.5-flash and 2.5-flash-lite support this.
        max_output_tokens: 8192,
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const oneLine = errText.replace(/\s+/g, " ").trim().substring(0, 400);
    const err = new Error(`rewrite ${res.status}: ${oneLine}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const finishReason = data?.candidates?.[0]?.finishReason;
  const text = data?.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === "string")?.text;
  if (!text) {
    throw new Error(`no text in response (${finishReason || "unknown"})`);
  }
  const parsed = extractJsonFromModelText(text);
  if (!parsed) {
    const preview = text.replace(/\s+/g, " ").substring(0, 200);
    throw new Error(`bad JSON (finishReason=${finishReason || "?"}, preview="${preview}…")`);
  }
  return parsed;
}

// Public: rewrite one article. Retries transient errors (429, 5xx). Throws on permanent.
// Returns { title, summary, contentHtml } on success.
async function rewriteArticle({ title, summary, contentHtml, langMode, apiKey }) {
  // Extract paragraphs from the existing HTML body
  const paragraphs = [];
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(contentHtml || ""))) {
    const t = stripTags(m[1]);
    if (t) paragraphs.push(t);
  }
  if (paragraphs.length === 0) return null;

  const promptText = buildRewritePrompt({ title, summary, paragraphs, langMode });
  const attempts = [
    { waitBefore: 0 },
    { waitBefore: 2000 },
    { waitBefore: 5000 },
  ];

  let lastErr = null;
  for (const a of attempts) {
    if (a.waitBefore) await new Promise((r) => setTimeout(r, a.waitBefore));
    try {
      const result = await callGeminiTextOnce({ apiKey, model: REWRITE_MODEL, promptText });
      if (
        typeof result.title !== "string" ||
        typeof result.summary !== "string" ||
        !Array.isArray(result.content_paragraphs)
      ) {
        throw new Error("incomplete rewrite output");
      }
      const newContentHtml = result.content_paragraphs
        .filter((p) => typeof p === "string" && p.trim())
        .map((p) => "<p>" + p.trim() + "</p>")
        .join("\n");
      return {
        title: result.title.trim() || title,
        summary: result.summary.trim() || summary,
        contentHtml: newContentHtml || contentHtml,
      };
    } catch (e) {
      lastErr = e;
      if (!e.status || !isTransientStatus(e.status)) throw e;
    }
  }
  throw lastErr || new Error("rewrite: exhausted retries");
}

// Derive an English headline from the OnlineKhabar URL slug.
// OnlineKhabar URLs end with an editorial English kebab-case slug, e.g.:
//   /2026/05/1928871/new-record-set-on-everest-in-terms-of-number-of-climbers
// We use this for `english_title` on Nepali-mode posts so that the backend's
// `slugify(english_title)` produces a UNIQUE slug per article — empty strings
// all slugify to the same value and violate the news.slug UNIQUE constraint.
function urlToEnglishTitle(url) {
  if (!url) return "";
  const cleaned = String(url).replace(/[?#].*$/, "").replace(/\/+$/, "");
  const parts = cleaned.split("/");
  const lastSeg = parts[parts.length - 1] || "";
  if (!lastSeg || /^\d+$/.test(lastSeg)) return "";
  const spaced = lastSeg.replace(/-+/g, " ").trim();
  if (!spaced) return "";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ─── Build news item matching batch-post-news.js JSON schema ───
// Accepts pre-computed title/summary/content so callers can inject rewritten versions.
function buildNewsItem({ rss, title, summary, contentHtml, langMode }) {
  const base = {
    author_name: "NEPSE Trading",
    // "नीति तथा कार्यक्रम" is FIRST so the news card variant (which renders
    // tags[0] as the visible badge) shows the section tag instead of "Latest".
    // "Latest" stays in the array so newest-first feeds still include it.
    tags: ["नीति तथा कार्यक्रम", "Latest"],
    thumbnail_url: rss.image || "",
    _internal_category: (rss.categories && rss.categories[0]) || "",
    _guid: rss.guid,
    _pubDate: rss.pubDate ? rss.pubDate.toISOString() : "",
    _source_url: rss.link,
  };

  const fallbackContent = `<p>${title}</p>`;
  if (langMode === "english") {
    return {
      ...base,
      english_title: title,
      english_summary: summary,
      english_content: contentHtml || fallbackContent,
      nepali_title: "",
      nepali_summary: "",
      nepali_content: "",
    };
  }
  // Nepali mode: english_title MUST be non-empty and unique-per-article so the
  // backend's slug generation doesn't collide. Derive it from the source URL.
  // For the rare fallback case, build from the OnlineKhabar article ID embedded
  // in the GUID (e.g. https://www.onlinekhabar.com/?p=1928871 → id "1928871").
  // NOTE: do NOT pass rss.guid back into urlToEnglishTitle — the GUID's last
  // path segment is always "www.onlinekhabar.com" after we strip the query,
  // which would yield the same title for every article and collide on slug.
  const guidId = (rss.guid || "").match(/[?&]p=(\d+)/)?.[1] || "";
  const derivedEnglishTitle =
    urlToEnglishTitle(rss.link) ||
    (guidId ? `Onlinekhabar post ${guidId}` : `Post ${Date.now()}`);
  return {
    ...base,
    english_title: derivedEnglishTitle,
    english_summary: "",
    english_content: "",
    nepali_title: title,
    nepali_summary: summary,
    nepali_content: contentHtml || fallbackContent,
  };
}

// ─── Queue + seen-state I/O ───
function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveQueue(arr) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(arr, null, 2), "utf-8");
}
function appendToQueue(items) {
  if (!items.length) return;
  const existing = loadQueue();
  saveQueue(existing.concat(items));
}

function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return new Set();
  try {
    const obj = JSON.parse(fs.readFileSync(SEEN_FILE, "utf-8"));
    if (Array.isArray(obj)) return new Set(obj);
    if (obj && Array.isArray(obj.guids)) return new Set(obj.guids);
    return new Set();
  } catch {
    return new Set();
  }
}
function saveSeen(set) {
  const payload = { guids: Array.from(set), updatedAt: new Date().toISOString() };
  fs.writeFileSync(SEEN_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

// ─── Process a list of RSS items into queue entries ───
// Options:
//   fetchDetail: bool — whether to fetch detail pages (Nepali path)
//   rewriteKey:  string|null — Gemini API key. If present, each item is rephrased.
async function itemsToQueue(rssItems, langMode, { fetchDetail, rewriteKey }) {
  const out = [];
  for (let i = 0; i < rssItems.length; i++) {
    const rss = rssItems[i];

    let bodyHtml = "";
    try {
      if (langMode === "english") {
        bodyHtml = cleanEnglishContent(rss.contentEncoded);
      } else if (fetchDetail) {
        const { bodyHtml: body, ogImage } = await fetchNepaliBody(rss.link);
        bodyHtml = body;
        // Backfill thumbnail from og:image when RSS didn't provide one
        if (!rss.image && ogImage) rss.image = ogImage;
        await new Promise((r) => setTimeout(r, DETAIL_FETCH_DELAY_MS));
      } else {
        bodyHtml = `<p>${stripTags(rss.description)}</p>`;
      }
    } catch (e) {
      console.log(`   ⚠️  body fetch failed for ${rss.link}: ${e.message}`);
      bodyHtml = `<p>${stripTags(rss.description)}</p>`;
    }

    // Default values straight from the scrape
    let finalTitle = rss.title || "";
    let finalSummary =
      makeSummary(stripTags(bodyHtml)) || makeSummary(stripTags(rss.description));
    let finalContent = bodyHtml;
    let rewriteMark = "";

    // Optional rewriter step
    if (rewriteKey) {
      try {
        const rw = await rewriteArticle({
          title: finalTitle,
          summary: finalSummary,
          contentHtml: finalContent,
          langMode,
          apiKey: rewriteKey,
        });
        if (rw) {
          finalTitle = rw.title;
          finalSummary = rw.summary;
          finalContent = rw.contentHtml;
          rewriteMark = " ✏️";
        }
      } catch (e) {
        console.log(
          `   ⚠️  rewrite failed for "${(rss.title || "").substring(0, 60)}": ${e.message.substring(0, 160)}`
        );
        // Keep original values on failure.
      }
      // Pace ourselves below the free-tier RPM cap
      await new Promise((r) => setTimeout(r, REWRITE_DELAY_MS));
    }

    const item = buildNewsItem({
      rss,
      title: finalTitle,
      summary: finalSummary,
      contentHtml: finalContent,
      langMode,
    });
    out.push(item);

    // Progress dot, with a checkmark for rewritten items
    process.stdout.write(`   [${i + 1}/${rssItems.length}]${rewriteMark} ${(finalTitle || "").substring(0, 60)}\n`);
  }
  return out;
}

// ─── Mode: batch ───
async function runBatch() {
  console.log("\n📰 OnlineKhabar Batch Fetcher\n");
  const langMode = await askLanguage();
  const cutoff = await askCutoff();
  const maxCount = await askCount();
  const useRewriter = await askRewriter();

  let rewriteKey = null;
  if (useRewriter) {
    rewriteKey = await getGeminiKey();
    if (!rewriteKey) console.log("   ⚠️  No API key provided — rewriting disabled for this run.");
  }
  closeRL();

  const cutoffNpt = new Date(cutoff.getTime() + NPT_OFFSET_MS);
  console.log(
    `\n⏰ Cutoff: ${cutoffNpt.toISOString().replace("T", " ").substring(0, 16)} NPT (items published BEFORE this are skipped)`
  );
  console.log(`📦 Max items: ${maxCount}`);
  console.log(`🌐 Language: ${langMode}`);
  if (rewriteKey) {
    console.log(`✏️  Rewriter: ON (model=${REWRITE_MODEL}, ~${REWRITE_DELAY_MS}ms per item)`);
  }

  const feed = langMode === "english" ? ENGLISH_FEED : NEPALI_FEED;
  console.log(`\n⏳ Fetching RSS from ${feed} ...`);
  const rssItems = await fetchRssPages(feed, { cutoff, maxItems: maxCount });
  console.log(`✅ Got ${rssItems.length} RSS item(s) after cutoff`);

  // Dedup against seen
  const seen = loadSeen();
  const fresh = rssItems.filter((it) => !seen.has(it.guid));
  if (fresh.length < rssItems.length) {
    console.log(`   ↳ ${rssItems.length - fresh.length} already in seen-onlinekhabar.json — skipping those`);
  }
  if (fresh.length === 0) {
    console.log("\nNothing new to add. Queue unchanged.");
    return;
  }

  console.log(`\n📰 Building ${fresh.length} news item(s)${langMode === "nepali" ? " (fetching detail pages)" : ""}${rewriteKey ? " + rewriting" : ""}...`);
  const queueItems = await itemsToQueue(fresh, langMode, {
    fetchDetail: langMode === "nepali",
    rewriteKey,
  });

  appendToQueue(queueItems);
  for (const it of fresh) seen.add(it.guid);
  saveSeen(seen);

  console.log(`\n✅ Appended ${queueItems.length} item(s) to ${path.basename(QUEUE_FILE)}`);
  console.log(`📝 Review the file, then run:`);
  console.log(`     node batch-post-news.js --file=${path.basename(QUEUE_FILE)}\n`);
}

// ─── Mode: watch (live daemon) ───
async function runWatch() {
  console.log("\n📡 OnlineKhabar Live Watcher\n");
  const langMode = await askLanguage();
  const useRewriter = await askRewriter();
  let rewriteKey = null;
  if (useRewriter) {
    rewriteKey = await getGeminiKey();
    if (!rewriteKey) console.log("   ⚠️  No API key provided — rewriting disabled.");
  }
  closeRL();

  const feed = langMode === "english" ? ENGLISH_FEED : NEPALI_FEED;
  console.log(`🌐 Language: ${langMode}`);
  console.log(`🔗 Feed: ${feed}`);
  console.log(`⏲️  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`📥 Queue file: ${path.basename(QUEUE_FILE)}`);
  if (rewriteKey) {
    console.log(`✏️  Rewriter: ON (model=${REWRITE_MODEL})`);
  }

  // First poll: capture current top GUIDs as already-seen so we only catch FUTURE items.
  // We only persist new entries when they're truly new on subsequent polls.
  let seen = loadSeen();
  const isFirstRun = seen.size === 0;

  try {
    const initial = await fetchRssPages(feed, { maxItems: 100, maxPages: 2 });
    if (isFirstRun) {
      for (const it of initial) seen.add(it.guid);
      saveSeen(seen);
      console.log(
        `\n📌 First run — seeded seen-set with ${initial.length} current GUID(s).` +
          " Daemon will only act on items published AFTER this point.\n"
      );
    } else {
      console.log(`\n📌 Resuming with ${seen.size} GUID(s) already in seen-set.\n`);
    }
  } catch (e) {
    console.log(`⚠️  Initial RSS probe failed: ${e.message}. Continuing into poll loop.`);
  }

  // Graceful shutdown — save state on Ctrl+C
  let shuttingDown = false;
  process.on("SIGINT", () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log("\n🛑 SIGINT — saving state and exiting...");
    saveSeen(seen);
    process.exit(0);
  });

  // Poll loop
  let pollCount = 0;
  for (;;) {
    pollCount++;
    const stamp = new Date().toISOString().replace("T", " ").substring(0, 19);
    try {
      const rssItems = await fetchRssPages(feed, { maxItems: 100, maxPages: 2 });
      const fresh = rssItems.filter((it) => !seen.has(it.guid));
      if (fresh.length > 0) {
        console.log(`\n[${stamp}] 🆕 ${fresh.length} new item(s) detected`);
        const queueItems = await itemsToQueue(fresh, langMode, {
          fetchDetail: langMode === "nepali",
          rewriteKey,
        });
        appendToQueue(queueItems);
        for (const it of fresh) seen.add(it.guid);
        saveSeen(seen);
        for (const q of queueItems) {
          const t = q.english_title || q.nepali_title || "(untitled)";
          console.log(`   + ${t.substring(0, 80)}`);
        }
        console.log(
          `   ↳ Appended to ${path.basename(QUEUE_FILE)} — drain it with: node batch-post-news.js --file=${path.basename(QUEUE_FILE)}`
        );
      } else if (pollCount % 10 === 0) {
        // Heartbeat every ~10 minutes
        console.log(`[${stamp}] 💓 still watching — ${seen.size} seen, queue=${loadQueue().length}`);
      }
    } catch (e) {
      console.log(`[${stamp}] ⚠️  poll error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ─── Mode: reset (clear queue, keep seen) ───
function runReset() {
  const before = loadQueue().length;
  saveQueue([]);
  console.log(`\n🧹 Cleared ${path.basename(QUEUE_FILE)} (${before} item(s) removed).`);
  console.log(`   seen-onlinekhabar.json preserved so already-posted items won't reappear.\n`);
}

// ─── Entry ───
async function main() {
  if (isReset) {
    runReset();
    return;
  }
  if (isWatch) {
    await runWatch();
    return;
  }
  await runBatch();
}

main().catch((e) => {
  console.error("\nFatal error:", e.message);
  process.exit(1);
});
