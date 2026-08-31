// watch-live-blog.js
// Polls onlinekhabar.com homepage for the live "नीति तथा कार्यक्रम" feed
// widget, consolidates all updates into one news article body, and
// POST → PATCH cycles a single news post each iteration. Same tag as
// fetch-onlinekhabar.js so it surfaces in the new homepage section.
//
//   node watch-live-blog.js                 → poll every 60s, daemon mode
//   node watch-live-blog.js --once          → single fetch, post or patch, exit
//   node watch-live-blog.js --dry-run       → show what would be posted, no API call
//   node watch-live-blog.js --reset         → delete state file (forces a fresh POST next run)
//
// State: live-blog-state.json   { slug, newsId, lastBodyHash, sourceUrl, updatedAt }
// JWT:   .jwt file (same one batch-post-news.js uses)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─── Config ───
const HOMEPAGE_URL = "https://www.onlinekhabar.com/";
const API_BASE = "https://api.nepsetrading.com";
const STATE_FILE = path.join(__dirname, "live-blog-state.json");
const JWT_FILE = path.join(__dirname, ".jwt");
const POLL_INTERVAL_MS = 60 * 1000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TAGS = ["budget event", "Latest"];

// ─── CLI args ───
const args = process.argv.slice(2);
const isOnce = args.includes("--once");
const isDryRun = args.includes("--dry-run");
const isReset = args.includes("--reset");

// ─── HTML helpers ───
function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;|&#8230;/g, "…")
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
  )
    .replace(/\s+/g, " ")
    .trim();
}

// Convert kebab-case URL slug to title-cased English string for english_title.
// This keeps the backend's slugify output stable and unique per article.
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

// ─── Gemini text rephraser (mirrors fetch-onlinekhabar.js's helpers) ───
const GEMINI_KEY_FILE = path.join(__dirname, ".gemini-key");
const REWRITE_MODEL = (process.env.REWRITE_MODEL || "gemini-2.5-flash-lite").trim();
// 15 RPM = one call every 4s. We target a bit slower (4.5s) for safety.
// Override with REWRITE_DELAY_MS env var if your tier throttles harder.
const REWRITE_DELAY_MS = Math.max(1000, parseInt(process.env.REWRITE_DELAY_MS || "4500", 10));

// Reads ALL Gemini keys so we can rotate to a backup when the active key hits
// 429 (quota) or 403 (project denied). Sources, in priority order:
//   1. GEMINI_API_KEY env var — single key OR comma-separated list
//   2. .gemini-key  file — single key (one line)
//   3. .gemini-keys file — one key per line (# comment lines ignored)
function getGeminiKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) {
    for (const part of process.env.GEMINI_API_KEY.split(",")) {
      const t = part.trim();
      if (t) keys.push(t);
    }
  }
  if (fs.existsSync(GEMINI_KEY_FILE)) {
    const k = fs.readFileSync(GEMINI_KEY_FILE, "utf-8").trim();
    if (k) keys.push(k);
  }
  const multiFile = path.join(__dirname, ".gemini-keys");
  if (fs.existsSync(multiFile)) {
    for (const raw of fs.readFileSync(multiFile, "utf-8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      keys.push(line);
    }
  }
  return Array.from(new Set(keys));
}

// Module-level active-key cursor. Persists across the whole daemon run so once
// we've rotated past an exhausted key we don't keep retrying it every poll.
let _activeKeyIndex = 0;

function getActiveKey() {
  const keys = getGeminiKeys();
  if (keys.length === 0) return null;
  return keys[Math.min(_activeKeyIndex, keys.length - 1)];
}

// Advance to the next key. Returns false when no backup keys remain.
function rotateKey() {
  const keys = getGeminiKeys();
  if (_activeKeyIndex + 1 >= keys.length) return false;
  _activeKeyIndex++;
  console.log(
    `   🔑 active key hit quota/denied — rotating to backup key ${_activeKeyIndex + 1}/${keys.length}`
  );
  return true;
}

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

async function callGeminiText(promptText) {
  const apiKey = getActiveKey();
  if (!apiKey) throw new Error("no Gemini key available");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${REWRITE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        response_mime_type: "application/json",
        temperature: 0.5,
        max_output_tokens: 4096,
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(
      `rephrase ${res.status}: ${errText.replace(/\s+/g, " ").substring(0, 300)}`
    );
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.find(
    (p) => typeof p.text === "string"
  )?.text;
  if (!text) throw new Error("no text in response");
  const parsed = extractJsonFromModelText(text);
  if (!parsed) throw new Error("could not parse JSON");
  return parsed;
}

async function callGeminiWithRetry(promptText) {
  const totalKeys = Math.max(1, getGeminiKeys().length);
  let lastErr = null;
  // Outer loop: one pass per key. Inner loop: transient-error retries on the
  // current key. On 429/403 we rotate to the next key; on 5xx we retry the
  // same key; on permanent errors we throw immediately.
  for (let k = 0; k < totalKeys; k++) {
    const waits = [0, 2000, 5000];
    let shouldRotate = false;
    for (const wait of waits) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        return await callGeminiText(promptText);
      } catch (e) {
        lastErr = e;
        if (e.status === 429 || e.status === 403) {
          shouldRotate = true;
          break;
        }
        if (e.status && isTransientStatus(e.status)) continue; // retry same key
        throw e; // permanent (400/401/404 etc.)
      }
    }
    if (shouldRotate) {
      if (!rotateKey()) break; // no more backup keys → give up
    } else {
      break; // exhausted 5xx retries — server issue, rotating won't help
    }
  }
  throw lastErr;
}

async function rephraseLiveTitle(liveTitle) {
  const prompt = `Rephrase this Nepali news live-blog headline. Input is in Nepali (Devanagari). Output MUST be in the SAME language.

STRICT RULES:
- Preserve names, dates, numbers, percentages EXACTLY. Do NOT translate proper nouns.
- Keep approximately the same length.
- No emojis. No source attribution. Do not mention OnlineKhabar.

Original headline:
${liveTitle}

Return ONLY this JSON, no prose, no code fences:
{ "title": "rephrased headline" }`;

  const result = await callGeminiWithRetry(prompt);
  if (typeof result.title !== "string") throw new Error("no title in result");
  return result.title.trim() || liveTitle;
}

async function rephraseUpdate({ title, bodyHtml }) {
  const paragraphs = [];
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(bodyHtml || ""))) {
    const t = stripTags(m[1]);
    if (t) paragraphs.push(t);
  }
  if (!title && paragraphs.length === 0) return null;

  const prompt = `You are rephrasing a Nepali news live-blog update. Input is in Nepali (Devanagari). Output MUST be in the SAME language.

STRICT RULES:
- Preserve EXACTLY: names of people, organizations, places, dates, numbers, percentages, currency figures, quoted text.
- Do NOT add or infer information. Do NOT remove information.
- Restructure sentences and use synonyms where natural in Nepali.
- Keep approximately the same length per paragraph.
- No emojis. No source attribution. Do not mention OnlineKhabar.

Original title:
${title}

Original paragraphs (in order):
${paragraphs.map((p, i) => `[P${i + 1}] ${p}`).join("\n")}

Return ONLY this JSON object, no prose, no code fences:
{
  "title": "rephrased title",
  "paragraphs": ["rephrased P1", "rephrased P2", ...]
}`;

  const result = await callGeminiWithRetry(prompt);
  if (typeof result.title !== "string" || !Array.isArray(result.paragraphs)) {
    throw new Error("incomplete rephrase output");
  }
  const newBody = result.paragraphs
    .filter((p) => typeof p === "string" && p.trim())
    .map((p) => `<p>${p.trim()}</p>`)
    .join("\n");
  return { title: result.title.trim() || title, bodyHtml: newBody };
}

// ─── Parsing ───
// Returns { liveTitle, sourceUrl, postId, updates: [{ feedId, timestamp, title, bodyHtml, firstImageUrl }] }
// or null if the live widget isn't present on the page right now.
function parseLiveBlog(html) {
  const wrapIdx = html.indexOf('<div class="ok-livefeed-list-wrap"');
  if (wrapIdx < 0) return null;

  // Pull post id from the wrap div
  const postIdMatch = html
    .substring(wrapIdx, wrapIdx + 200)
    .match(/data-post-id="(\d+)"/);
  const postId = postIdMatch ? postIdMatch[1] : "";

  // Title and source URL live in the <h2> just above the wrap, wrapped in an <a>.
  // Look in a generous window before wrapIdx.
  const above = html.substring(Math.max(0, wrapIdx - 8000), wrapIdx);
  const linkMatch = above.match(/<a\s+href="([^"]+)"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>/);
  const sourceUrl = linkMatch ? linkMatch[1] : "";
  const liveTitle = linkMatch ? stripTags(linkMatch[2]) : "Live Niti Tatha Karyakram";

  // Determine end of the feed container. Use the next major section marker.
  // The widget is followed by other homepage sections, so any of these is a safe stop.
  const endProbes = [
    "</section>",
    '<div class="oklf_view_more',
    '<div class="ok-section',
    '<section class="ok-section',
  ];
  let endIdx = -1;
  for (const p of endProbes) {
    const idx = html.indexOf(p, wrapIdx + 200);
    if (idx > 0 && (endIdx < 0 || idx < endIdx)) endIdx = idx;
  }
  const slice = html.substring(wrapIdx, endIdx > 0 ? endIdx : wrapIdx + 200000);

  // Each update is delimited by the live-update-content div with its data-feed-id.
  // Split on the opening tag — the FIRST chunk is the wrap-div preamble (skip it).
  const parts = slice.split(/<div class="live-update-content"\s+data-feed-id="(\d+)"\s*>/);
  // parts shape: [preamble, id1, body1, id2, body2, ...]

  const updates = [];
  for (let i = 1; i < parts.length; i += 2) {
    const feedId = parts[i];
    const block = parts[i + 1] || "";

    const timeMatch = block.match(/<span class="updated-date">\s*([\s\S]*?)\s*<\/span>/);
    const titleMatch = block.match(/<h5[^>]*>([\s\S]*?)<\/h5>/);
    const bodyMatch = block.match(
      /<div class="live-update-content-area">([\s\S]*?)<div class="share-icons"/
    );

    const timestamp = timeMatch ? stripTags(timeMatch[1]).trim() : "";
    const title = titleMatch ? stripTags(titleMatch[1]).trim() : "";

    // Body: text paragraphs only. We deliberately DROP image-only paragraphs
    // because they'd hotlink OnlineKhabar's CDN images (which carry a visible
    // © onlinekhabar.com watermark, breaking the "no source attribution" rule).
    let bodyHtml = "";
    if (bodyMatch) {
      const paraRe = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
      const paragraphs = [];
      let m;
      while ((m = paraRe.exec(bodyMatch[1]))) {
        const text = stripTags(m[1]);
        if (text) paragraphs.push(`<p>${text}</p>`);
      }
      bodyHtml = paragraphs.join("\n");
    }

    updates.push({ feedId, timestamp, title, bodyHtml });
  }

  return { liveTitle, sourceUrl, postId, updates };
}

// Newest-first consolidated HTML body. OnlineKhabar's homepage already lists
// newest at the top, so we just join in the order parsed.
// Timestamps (e.g. "4 minutes ago, 17:43:41") are intentionally omitted from
// the rendered output — the post has a single "Updated on …" timestamp at
// the top of the news page; per-update timestamps just clutter the body.
function buildConsolidatedBody(live) {
  const blocks = [];
  for (const u of live.updates) {
    if (u.title) blocks.push(`<p><strong>${u.title}</strong></p>`);
    if (u.bodyHtml) blocks.push(u.bodyHtml);
    blocks.push("<hr/>");
  }
  // Trim the trailing <hr/>
  while (blocks.length && blocks[blocks.length - 1] === "<hr/>") blocks.pop();
  return blocks.join("\n");
}

function makeSummary(updates) {
  // Pick the freshest update that has been REPHRASED — otherwise the card
  // preview would show OnlineKhabar's verbatim wording even when most of the
  // body has been rephrased. Falls back to the absolute latest if nothing
  // has been rephrased yet.
  if (!updates.length) return "";
  const u = updates.find((x) => x.wasRephrased) || updates[0];
  const firstSentence = stripTags(u.bodyHtml).split(/।|\.\s/)[0] || "";
  const summary = (u.title ? u.title + " — " : "") + firstSentence.trim();
  return summary.length > 220 ? summary.substring(0, 217) + "…" : summary;
}

// ─── State I/O ───
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}
function readJwt() {
  if (!fs.existsSync(JWT_FILE)) {
    throw new Error(
      ".jwt file not found. Run batch-post-news.js once first so it saves the JWT, or paste your JWT into .jwt manually."
    );
  }
  return fs.readFileSync(JWT_FILE, "utf-8").trim();
}

// ─── API calls ───
async function createNews({ nepaliTitle, nepaliContent, nepaliSummary, englishTitle, thumbnailUrl, jwt }) {
  const body = {
    author_name: "NEPSE Trading",
    english_title: englishTitle,
    english_summary: "",
    english_content: "",
    nepali_title: nepaliTitle,
    nepali_summary: nepaliSummary,
    nepali_content: nepaliContent,
    tags: TAGS,
  };
  if (thumbnailUrl) body.thumb_nail = thumbnailUrl;

  const r = await fetch(`${API_BASE}/news`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`POST /news ${r.status}: ${text.substring(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function patchNews({ slug, nepaliTitle, nepaliContent, nepaliSummary, jwt }) {
  const body = {
    nepali_summary: nepaliSummary,
    nepali_content: nepaliContent,
  };
  if (nepaliTitle) body.nepali_title = nepaliTitle;
  const r = await fetch(`${API_BASE}/news/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`PATCH /news/${slug} ${r.status}: ${text.substring(0, 400)}`);
  }
  return text;
}

// Fetch the live-blog HTML from wherever it currently lives.
// During an active event, the widget is on the homepage.
// After the event ends, OnlineKhabar archives the widget into the article
// page itself — same markup, different URL. We try homepage first, fall back
// to the article URL from state if we have it.
async function fetchLiveBlogHtml(state) {
  async function tryUrl(url) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) return null;
      const html = await r.text();
      if (html.includes("ok-livefeed-list-wrap")) return html;
    } catch {}
    return null;
  }
  const fromHomepage = await tryUrl(HOMEPAGE_URL);
  if (fromHomepage) return { html: fromHomepage, source: HOMEPAGE_URL };
  if (state?.sourceUrl) {
    const fromArticle = await tryUrl(state.sourceUrl);
    if (fromArticle) return { html: fromArticle, source: state.sourceUrl };
  }
  return null;
}

// ─── Main poll cycle ───
async function pollOnce(state, jwt, rephraseEnabled) {
  const fetched = await fetchLiveBlogHtml(state);
  if (!fetched) {
    return {
      changed: false,
      reason: "no live widget on homepage or archived article page",
    };
  }
  const html = fetched.html;

  const live = parseLiveBlog(html);
  if (!live || live.updates.length === 0) {
    return { changed: false, reason: "live widget present but parsed 0 updates" };
  }

  // Working copy of state so we can extend it with new rephrased entries
  // without disturbing the caller's reference until we saveState() below.
  let working = state ? { ...state } : {};
  working.rephrasedUpdates = working.rephrasedUpdates || {};

  // (1) Live title: rephrase exactly once, cache forever.
  let displayLiveTitle = live.liveTitle;
  if (rephraseEnabled && !working.rephrasedLiveTitle && !isDryRun) {
    console.log("   ✏️  rephrasing live title...");
    try {
      working.rephrasedLiveTitle = await rephraseLiveTitle(live.liveTitle);
      saveState(working); // checkpoint
      await new Promise((r) => setTimeout(r, REWRITE_DELAY_MS));
    } catch (e) {
      console.log(`   ⚠️  liveTitle rephrase failed: ${e.message.substring(0, 100)}`);
    }
  }
  if (working.rephrasedLiveTitle) displayLiveTitle = working.rephrasedLiveTitle;

  // (2) Per-update rephrase: cache by feedId so each update is rephrased once.
  // If we hit a 429, the per-minute (or per-second) bucket is full — stop trying
  // for the rest of this poll. Failed updates fall back to verbatim text and will
  // be retried on the next poll. This prevents the retry storm from burning all
  // remaining quota on a single poll.
  const finalUpdates = [];
  let quotaExhaustedThisPoll = false;
  for (const u of live.updates) {
    let rep = working.rephrasedUpdates[u.feedId];
    if (!rep && rephraseEnabled && !isDryRun && !quotaExhaustedThisPoll) {
      console.log(`   ✏️  rephrasing feedId=${u.feedId}: ${(u.title || "").substring(0, 60)}`);
      try {
        rep = await rephraseUpdate({ title: u.title, bodyHtml: u.bodyHtml });
        if (rep) {
          working.rephrasedUpdates[u.feedId] = rep;
          saveState(working); // checkpoint after every successful rephrase
        }
        await new Promise((r) => setTimeout(r, REWRITE_DELAY_MS));
      } catch (e) {
        const msg = e.message || "";
        console.log(`   ⚠️  rephrase failed for ${u.feedId}: ${msg.substring(0, 120)}`);
        // A 429/403 thrown here means callGeminiWithRetry already tried rotating
        // through ALL keys and they're all exhausted/denied. Stop for this poll.
        if (e.status === 429 || e.status === 403 || /\b(429|403)\b/.test(msg)) {
          quotaExhaustedThisPoll = true;
          console.log(
            `   ⏸️  all keys exhausted — skipping further rephrases this poll, will retry next cycle`
          );
        }
      }
    }
    finalUpdates.push({
      feedId: u.feedId,
      timestamp: u.timestamp, // factual, NEVER rephrased
      title: rep?.title || u.title,
      bodyHtml: rep?.bodyHtml || u.bodyHtml,
      // Summary derivation prefers updates with this flag set so we never
      // accidentally use OnlineKhabar's verbatim wording in the card preview.
      wasRephrased: !!rep,
    });
  }

  // (3) Build consolidated output from rephrased (or fallback) versions.
  const body = buildConsolidatedBody({ ...live, updates: finalUpdates });
  const summary = makeSummary(finalUpdates);
  // Hash covers title + summary + body so any change to ANY of them triggers
  // a PATCH. Previously only body was hashed, which meant summary/title
  // changes (e.g., when a rephrased update becomes the summary source) didn't
  // get pushed to the backend.
  const hash = crypto
    .createHash("sha256")
    .update(displayLiveTitle + "|" + summary + "|" + body)
    .digest("hex");

  if (working.lastBodyHash === hash) {
    // No change — but rephrasedUpdates may have grown above; keep that saved.
    return { changed: false, reason: "no content change", updateCount: live.updates.length };
  }

  if (isDryRun) {
    return {
      changed: true,
      reason: "DRY RUN — would POST/PATCH",
      updateCount: live.updates.length,
      preview: { title: displayLiveTitle, summary, bodyLen: body.length },
    };
  }

  if (!working.slug) {
    // First POST. Thumbnail is intentionally empty — see file header.
    const englishTitle =
      urlToEnglishTitle(live.sourceUrl) ||
      `Live niti tatha karyakram ${live.postId || Date.now()}`;
    const result = await createNews({
      nepaliTitle: displayLiveTitle,
      nepaliContent: body,
      nepaliSummary: summary,
      englishTitle,
      thumbnailUrl: "",
      jwt,
    });
    const slug = result?.news?.slug || result?.data?.slug;
    const newsId = result?.news?.id || result?.data?.id;
    if (!slug) {
      throw new Error(
        `POST succeeded but no slug returned: ${JSON.stringify(result).substring(0, 300)}`
      );
    }
    working = {
      ...working,
      slug,
      newsId,
      lastBodyHash: hash,
      sourceUrl: live.sourceUrl,
      postId: live.postId,
      updatedAt: new Date().toISOString(),
    };
    saveState(working);
    return { changed: true, reason: "posted", slug, newsId, updateCount: live.updates.length };
  }

  // Subsequent → PATCH the title (in case rephrased) and content.
  await patchNews({
    slug: working.slug,
    nepaliTitle: displayLiveTitle,
    nepaliContent: body,
    nepaliSummary: summary,
    jwt,
  });
  working.lastBodyHash = hash;
  working.updatedAt = new Date().toISOString();
  saveState(working);
  return {
    changed: true,
    reason: "patched",
    slug: working.slug,
    updateCount: live.updates.length,
  };
}

function ts() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

async function main() {
  if (isReset) {
    if (fs.existsSync(STATE_FILE)) {
      const prev = loadState();
      fs.unlinkSync(STATE_FILE);
      console.log(
        `🧹 Cleared live-blog-state.json (was tracking slug=${prev?.slug || "?"})`
      );
    } else {
      console.log("No live-blog-state.json to clear.");
    }
    return;
  }

  console.log("\n📡 Live blog watcher\n");
  console.log(`🔗 Source: ${HOMEPAGE_URL}`);
  console.log(`🏷️  Tags: ${TAGS.join(", ")}`);
  console.log(`📥 State: ${path.basename(STATE_FILE)}`);
  console.log(`⏲️  Poll: ${POLL_INTERVAL_MS / 1000}s${isOnce ? " (--once mode)" : ""}`);
  if (isDryRun) console.log("🔍 DRY RUN — no API calls");

  let jwt = "dry";
  if (!isDryRun) {
    try {
      jwt = readJwt();
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  }

  const geminiKeys = getGeminiKeys();
  const rephraseEnabled = geminiKeys.length > 0;
  if (rephraseEnabled) {
    console.log(
      `✏️  Rephraser: ON (model=${REWRITE_MODEL}, ${geminiKeys.length} key(s) w/ auto-rotation, ~${REWRITE_DELAY_MS}ms per call)`
    );
  } else {
    console.log(
      "⚠️  No Gemini keys found (.gemini-key or .gemini-keys) — content will be posted verbatim from OnlineKhabar (NOT recommended)."
    );
  }

  let state = loadState();
  if (state) {
    const cached = Object.keys(state.rephrasedUpdates || {}).length;
    console.log(
      `📌 Resuming — slug=${state.slug} (last hash ${state.lastBodyHash.substring(0, 8)}, ${cached} updates cached)`
    );
  } else {
    console.log("📌 First run — will POST on next change detected.");
  }

  process.on("SIGINT", () => {
    console.log("\n🛑 SIGINT — exiting.");
    process.exit(0);
  });

  let iter = 0;
  for (;;) {
    iter++;
    try {
      const r = await pollOnce(state, jwt, rephraseEnabled);
      if (r.changed) {
        console.log(
          `[${ts()}] ${r.reason} | slug=${r.slug || "?"} | ${r.updateCount} updates total`
        );
        if (r.preview) console.log("   preview:", JSON.stringify(r.preview, null, 2));
        // Refresh local state ref after a POST sets it.
        state = loadState();
      } else if (iter === 1 || iter % 10 === 0) {
        console.log(`[${ts()}] 💓 ${r.reason} (poll #${iter})`);
      }
    } catch (e) {
      console.log(`[${ts()}] ⚠️  ${e.message}`);
    }
    if (isOnce) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
