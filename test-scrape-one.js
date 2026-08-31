// test-scrape-one.js  — THROWAWAY end-to-end test (safe to delete).
// Scrapes ONE OnlineKhabar article, rephrases it via Gemini, and POSTs it to
// the backend tagged "budget event" so we can confirm the homepage section
// renders BEFORE the 4 PM budget live. Reuses the exact selectors + POST shape
// from fetch-onlinekhabar.js / watch-live-blog.js.
//
//   node test-scrape-one.js <article-url>
//   node test-scrape-one.js --dry-run <article-url>   (scrape+rephrase, no POST)

const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.nepsetrading.com";
const JWT_FILE = path.join(__dirname, ".jwt");
const KEYS_FILE = path.join(__dirname, ".gemini-keys");
const REWRITE_MODEL = (process.env.REWRITE_MODEL || "gemini-2.5-flash-lite").trim();
const TAGS = ["budget event", "Latest"];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const URL = args.find((a) => a.startsWith("http"));
if (!URL) {
  console.error("Usage: node test-scrape-one.js [--dry-run] <article-url>");
  process.exit(1);
}

function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&hellip;|&#8230;/g, "…").replace(/&#8211;/g, "–").replace(/&#8212;/g, "—")
    .replace(/&#8216;|&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"');
}
function stripTags(html) {
  return decodeEntities(
    (html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

const ENTRY_OPEN =
  /<div\b[^>]*\bclass=["'][^"']*\b(?:entry-content|okv4-post-content)\b[^"']*["'][^>]*>/i;
const END_MARKERS = [
  "<!-- .entry-content -->", '<div class="ok-post-emoji', '<div class="ok-news-tags',
  '<div class="single-after-content', '<div class="ok-post-social-shares', '<footer class="entry-footer',
];

async function fetchArticle(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  const html = await r.text();
  const titleM = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  const title = titleM ? decodeEntities(titleM[1]).trim() : "";
  const openM = html.match(ENTRY_OPEN);
  if (!openM) throw new Error("no entry-content div");
  const start = openM.index + openM[0].length;
  let end = -1;
  for (const m of END_MARKERS) {
    const i = html.indexOf(m, start);
    if (i > 0 && (end < 0 || i < end)) end = i;
  }
  const slice = html.substring(start, end > 0 ? end : start + 80000);
  const paras = [];
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(slice))) {
    const t = stripTags(m[1]);
    if (t && t.length > 1) paras.push(t);
  }
  return { title, paras };
}

function getKeys() {
  if (!fs.existsSync(KEYS_FILE)) return [];
  return fs.readFileSync(KEYS_FILE, "utf-8").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

async function rephrase({ title, paras }) {
  const keys = getKeys();
  if (keys.length === 0) throw new Error("no gemini keys");
  const prompt = `You are rephrasing a Nepali news article. Input is in Nepali (Devanagari). Output MUST be in the SAME language.
STRICT RULES:
- Preserve EXACTLY: names, organizations, places, dates, numbers, percentages, currency, quotes.
- Do NOT add or remove information. Restructure sentences, use synonyms naturally.
- No emojis. No source attribution. Do not mention OnlineKhabar.
Original title:
${title}
Original paragraphs:
${paras.map((p, i) => `[P${i + 1}] ${p}`).join("\n")}
Return ONLY this JSON, no prose, no code fences:
{ "title": "rephrased title", "paragraphs": ["rephrased P1", ...] }`;

  let lastErr;
  for (const key of keys) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${REWRITE_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { response_mime_type: "application/json", temperature: 0.5, max_output_tokens: 8192 },
        }),
      });
      if (!res.ok) { lastErr = new Error(`gemini ${res.status}`); if (res.status === 429 || res.status === 403) continue; throw lastErr; }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === "string")?.text;
      const j = JSON.parse(text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1));
      if (typeof j.title === "string" && Array.isArray(j.paragraphs)) return j;
      throw new Error("bad json");
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

(async () => {
  console.log(`\nScraping: ${URL}`);
  const art = await fetchArticle(URL);
  console.log(`  title: ${art.title}`);
  console.log(`  paragraphs: ${art.paras.length}`);
  if (art.paras.length === 0) throw new Error("no body paragraphs extracted");

  console.log(`Rephrasing via Gemini (${REWRITE_MODEL})...`);
  const rp = await rephrase(art);
  const body = rp.paragraphs.filter((p) => p && p.trim()).map((p) => `<p>${p.trim()}</p>`).join("\n");
  const summary = (stripTags(body).split(/।|\.\s/)[0] || "").substring(0, 200);
  console.log(`  rephrased title: ${rp.title}`);
  console.log(`  rephrased paragraphs: ${rp.paragraphs.length}, body chars: ${body.length}`);

  if (isDryRun) { console.log("\nDRY RUN — not posting."); return; }

  const jwt = fs.readFileSync(JWT_FILE, "utf-8").trim();
  const englishTitle = `Scrape test ${URL.split("/").pop()}`;
  const res = await fetch(`${API_BASE}/news`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      author_name: "NEPSE Trading",
      english_title: englishTitle, english_summary: "", english_content: "",
      nepali_title: rp.title, nepali_summary: summary, nepali_content: body,
      tags: TAGS,
    }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`POST /news ${res.status}: ${txt.substring(0, 400)}`);
  let out; try { out = JSON.parse(txt); } catch { out = { raw: txt }; }
  const slug = out?.news?.slug || out?.data?.slug;
  const id = out?.news?.id || out?.data?.id;
  console.log(`\nPOSTED ✅  slug=${slug}  id=${id}`);
  console.log(`  view: https://www.nepsetrading.com/news/${slug}`);
  console.log(`  delete with: node delete-news.js  (slug ${slug} / id ${id})`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
