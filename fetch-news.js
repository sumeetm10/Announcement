// fetch-news.js
// Scrapes ShareSansar announcements and writes to news-to-post.json
// Interactive prompts: how many announcements + which language

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ─── Config ───
const LIST_URL = "https://www.sharesansar.com/announcement";
const OUTPUT_FILE = path.join(__dirname, "news-to-post.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ─── Interactive prompt (single shared readline) ───
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
    const a = await prompt("📊 How many announcements to fetch? (1-50, default 20): ");
    if (!a) return 20;
    const n = parseInt(a, 10);
    if (!isNaN(n) && n >= 1 && n <= 50) return n;
    console.log("   ⚠️  Enter a number between 1 and 50");
  }
}

async function askLanguage() {
  while (true) {
    console.log("\n🌐 Language options:");
    console.log("   1) English only");
    console.log("   2) Nepali only (you translate later before posting)");
    console.log("   3) Mix — both English & Nepali (Nepali marked [TRANSLATE])");
    const a = await prompt("Choose (1/2/3, default 3): ");
    if (!a || a === "3") return "mix";
    if (a === "1") return "english";
    if (a === "2") return "nepali";
    console.log("   ⚠️  Enter 1, 2, or 3");
  }
}

async function askVision() {
  const a = (await prompt(
    "\n🎨 Use Claude vision to generate full articles from notice images? (y/N): "
  )).toLowerCase();
  return a === "y" || a === "yes";
}

// ─── Gemini API key loader (mirrors .jwt pattern) ───
function getGeminiKeySync() {
  if (process.env.GEMINI_API_KEY) {
    console.log("🔑 Using Gemini key from GEMINI_API_KEY env var");
    return process.env.GEMINI_API_KEY;
  }
  const keyFile = path.join(__dirname, ".gemini-key");
  if (fs.existsSync(keyFile)) {
    const tok = fs.readFileSync(keyFile, "utf-8").trim();
    if (tok) {
      console.log("🔑 Using Gemini key from .gemini-key file");
      return tok;
    }
  }
  return null;
}

async function getGeminiKey() {
  const existing = getGeminiKeySync();
  if (existing) return existing;
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

// ─── Parse list page ───
function parseAnnouncementList(html, limit) {
  // Each announcement block starts with a div.featured-news-list
  // Title: <h4 class="featured-announcement-title">...</h4>
  // Link:  href="https://www.sharesansar.com/announcementdetail/..."
  // Date:  <span class="text-org">DATE</span>
  const results = [];
  const seen = new Set();

  // Extract each announcement block. Split by the known container class and process each chunk.
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

// ─── Parse detail page ───
function parseDetailPage(html, fallbackTitle) {
  // Title: <h1 style="font-size: 30px;">...</h1>
  const titleMatch = html.match(/<h1[^>]*style="font-size:\s*30px[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const title = titleMatch
    ? decodeEntities(stripTags(titleMatch[1]))
    : fallbackTitle;

  // Category (tag): <a ... class="tags">Category</a>
  const categoryMatch = html.match(/class="tags"[^>]*>([\s\S]*?)<\/a>/);
  const category = categoryMatch ? decodeEntities(stripTags(categoryMatch[1])) : "";

  // Published time: <h5><i class="fa fa-calendar"...> DATETIME
  const timeMatch = html.match(/<i class="fa fa-calendar"[^>]*>[\s\S]*?<\/i>\s*([^<]+?)<\/i>/);
  const publishedAt = timeMatch ? decodeEntities(stripTags(timeMatch[1])) : "";

  // Summary: <div id="newsdetail-content">...</div>
  const contentMatch = html.match(/<div id="newsdetail-content">([\s\S]*?)<\/div>/);
  const summaryHtml = contentMatch ? contentMatch[1].trim() : "";
  const summaryText = decodeEntities(stripTags(summaryHtml));

  // Image: <img id="announcement-image" src="...">
  const imgMatch = html.match(/<img\s+id="announcement-image"[^>]*src="([^"]+)"/);
  const image = imgMatch ? imgMatch[1] : "";

  return { title, category, publishedAt, summaryHtml, summaryText, image };
}

// ─── Rewrite title for SEO (different from original, never truncated mid-word) ───
function seoTitleEnglish(original, category) {
  let t = original.replace(/\.$/, "").trim();

  // Pattern rewrites for common announcement types
  // 1) "X has posted a net profit of Rs Y million and published its Nth quarter company analysis..."
  const netProfitMatch = t.match(
    /^(.+?)\s+has posted a net profit of Rs\s*([\d.,]+)\s*million/i
  );
  if (netProfitMatch) {
    const company = netProfitMatch[1].trim();
    const profit = netProfitMatch[2];
    const qMatch = t.match(/(\d+(?:st|nd|rd|th))\s+quarter/i);
    const qtr = qMatch ? qMatch[1] : "Latest";
    return `${company}: Rs ${profit}M Net Profit in ${qtr} Quarter | NEPSE`;
  }

  // 2) "X is opening its N units IPO shares..."
  const ipoMatch = t.match(/^(.+?)\s+is opening its\s*([\d,]+)\s*units?\s*IPO/i);
  if (ipoMatch) {
    return `${ipoMatch[1].trim()} IPO Opens: ${ipoMatch[2]} Units Available | NEPSE`;
  }

  // 3) "X has published a notice regarding ..."
  const noticeMatch = t.match(/^(.+?)\s+has published a notice regarding\s+(.+)$/i);
  if (noticeMatch) {
    const subj = noticeMatch[2].replace(/\s+on\s+.*$/, "").trim();
    return `${noticeMatch[1].trim()}: ${subj} | NEPSE Notice`;
  }

  // 4) Dividend announcements
  const divMatch = t.match(/^(.+?)\s+has (?:announced|declared|proposed)\s+.*?dividend/i);
  if (divMatch) {
    return `${divMatch[1].trim()} Declares Dividend | NEPSE`;
  }

  // Fallback: keep original, just append a suffix if it fits cleanly
  if (t.length <= 95) {
    if (category && !t.toLowerCase().includes(category.toLowerCase())) {
      return `${t} | ${category}`;
    }
    return `${t} | NEPSE`;
  }

  // Last resort: cut at a sentence/clause boundary, never mid-word
  const truncAt = Math.min(t.length, 100);
  let cut = t.substring(0, truncAt);
  const boundary = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf(", "),
    cut.lastIndexOf(" and "),
    cut.lastIndexOf(" - "),
    cut.lastIndexOf(" | ")
  );
  if (boundary > 40) cut = cut.substring(0, boundary);
  else {
    const sp = cut.lastIndexOf(" ");
    if (sp > 40) cut = cut.substring(0, sp);
  }
  return `${cut.trim()} | NEPSE`;
}

function seoSummaryEnglish(original) {
  const t = original.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length > 220) return t.substring(0, 217) + "...";
  return t;
}

// ─── Vision: download image, call Claude Haiku, get structured article ───
async function fetchImageAsBase64(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  const contentType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  const mediaType = allowed.includes(contentType) ? contentType : "image/jpeg";
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  // Gemini inline image limit is ~20MB. Bail only if clearly beyond that.
  if (buf.length > 19 * 1024 * 1024) {
    throw new Error(`image too large (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
  }
  return { base64: buf.toString("base64"), mediaType };
}

function extractJsonFromModelText(text) {
  if (!text) return null;
  // Strip ```json ... ``` or ``` ... ``` fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  // Find first { ... last matching }
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  const slice = candidate.substring(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function buildVisionPrompt(langMode, category) {
  const needEnglish = langMode === "english" || langMode === "mix";
  const needNepali = langMode === "nepali" || langMode === "mix";

  const fields = [];
  if (needEnglish) {
    fields.push(
      `  "english_title": "SEO headline, max 90 chars, ends with | NEPSE"`,
      `  "english_summary": "1-2 sentence summary, max 220 chars"`,
      `  "english_content": "<p>Para 1</p><p>Para 2</p><p>Para 3</p> (3-4 factual paragraphs)"`
    );
  } else {
    fields.push(
      `  "english_title": ""`,
      `  "english_summary": ""`,
      `  "english_content": ""`
    );
  }
  if (needNepali) {
    fields.push(
      `  "nepali_title": "Proper Nepali headline"`,
      `  "nepali_summary": "Proper Nepali 1-2 sentence summary"`,
      `  "nepali_content": "<p>Nepali para 1</p><p>Nepali para 2</p><p>Nepali para 3</p>"`
    );
  } else {
    fields.push(
      `  "nepali_title": ""`,
      `  "nepali_summary": ""`,
      `  "nepali_content": ""`
    );
  }

  return `You are analyzing a scanned official announcement from the Nepal Stock Exchange (NEPSE). The image contains a notice issued by a listed company, a mutual fund, or a regulator.

Read the notice carefully and produce a factual news article in the JSON schema below.

Category context: ${category || "(unknown)"}

STRICT FACTUAL RULES (read carefully):
- Preserve ALL proper nouns EXACTLY as they appear in the image — company names, fund names, person names, place names. Do NOT normalize, shorten, "correct", or transliterate variant spellings. If the notice says "Yambaling", write "Yambaling", not "Yambling". If unsure of a letter, reproduce what you see, do not guess.
- Use ONLY facts that are explicitly written in the image. Do NOT infer, guess, estimate, or fill in missing details from context.
- If a figure (amount, percentage, unit count, date, price, NAV, ratio) is NOT clearly visible in the image, OMIT IT entirely from the output. Never invent or round.
- If the purpose of the notice is ambiguous (e.g. could be dividend OR issuance OR rights), describe ONLY what is explicitly stated and do not classify beyond that.
- If the image is unreadable, low-quality, or contains insufficient information for a full article, produce a shorter article that only reports what IS legible. A 1-paragraph article with correct facts is far better than a 3-paragraph article with invented facts.

FORMAT RULES:
- No emojis anywhere.
- No mention of "ShareSansar" or any source attribution.
- Write in a neutral news-report tone.
- English content must be wrapped in <p>...</p> tags. 3 paragraphs if there is enough factual material, fewer if not.
- Nepali content must be proper Nepali (Devanagari), not placeholders or [TRANSLATE] markers. Preserve proper nouns in their original script when they appear that way in the image.
- If a language is not requested, set its fields to empty string "".

Return ONLY valid JSON matching this exact shape, no prose, no code fences:
{
${fields.join(",\n")}
}`;
}

// Single attempt at one (model, image, prompt). Throws on any non-2xx response.
async function callGeminiOnce({ model, base64, mediaType, promptText, apiKey }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mediaType, data: base64 } },
            { text: promptText },
          ],
        },
      ],
      generationConfig: {
        response_mime_type: "application/json",
        temperature: 0.3,
        // 8192 avoids truncation on long notices (e.g. regulator lists of insurers/brokers).
        max_output_tokens: 8192,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const oneLine = errText.replace(/\s+/g, " ").trim();
    const err = new Error(`vision ${res.status}: ${oneLine.substring(0, 600)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const finishReason = data?.candidates?.[0]?.finishReason;
  const textPart = data?.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === "string");
  const text = textPart?.text;
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason || finishReason;
    throw new Error(`no text in response (${blockReason || "unknown"})`);
  }
  const parsed = extractJsonFromModelText(text);
  if (!parsed) {
    // Include the finishReason (MAX_TOKENS, SAFETY, etc.) and a short preview of what
    // the model actually returned so the failure mode is obvious in the console.
    const preview = text.replace(/\s+/g, " ").substring(0, 200);
    throw new Error(
      `could not parse JSON from model response (finishReason=${finishReason || "?"}, preview="${preview}...")`
    );
  }
  return parsed;
}

// Transient: 429 (rate), 500/502/503/504 (upstream/overload). Retry these.
// Permanent: 400, 401, 403, 404 — don't retry.
function isTransient(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

async function generateArticleFromImage({ imageUrl, langMode, category, apiKey }) {
  const { base64, mediaType } = await fetchImageAsBase64(imageUrl);
  const promptText = buildVisionPrompt(langMode, category);

  // Primary model + a cheaper/more-available fallback. Env var overrides primary.
  // .trim() because Windows `set VAR=value && cmd` captures a trailing space.
  const primary = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
  const fallbackModel = "gemini-2.5-flash-lite";

  // Schedule: try primary with 3 attempts (waits 0s, 2s, 5s before each),
  // then fall back to lite once if primary keeps failing transiently.
  const attempts = [
    { model: primary, waitBefore: 0 },
    { model: primary, waitBefore: 2000 },
    { model: primary, waitBefore: 5000 },
  ];
  if (primary !== fallbackModel) {
    attempts.push({ model: fallbackModel, waitBefore: 2000 });
  }

  let lastErr = null;
  for (const a of attempts) {
    if (a.waitBefore) await new Promise((r) => setTimeout(r, a.waitBefore));
    try {
      return await callGeminiOnce({
        model: a.model,
        base64,
        mediaType,
        promptText,
        apiKey,
      });
    } catch (e) {
      lastErr = e;
      // Only retry on transient errors. Permanent errors (bad key, bad model, bad request) bail fast.
      if (!e.status || !isTransient(e.status)) throw e;
    }
  }
  throw lastErr || new Error("vision: exhausted retries");
}

// ─── Build news object per language choice ───
function buildNews({ detail, langMode, listItem, visionOverride }) {
  const englishTitle = seoTitleEnglish(detail.title, detail.category);
  const englishSummary = seoSummaryEnglish(detail.summaryText || detail.title);
  const englishContent =
    detail.summaryHtml && detail.summaryHtml.length > 20
      ? detail.summaryHtml
      : `<p>${detail.title}</p>`;

  // Tags: map ShareSansar category to your allowed tags
  const catLower = (detail.category || "").toLowerCase();
  const tags = new Set(["Latest"]);
  if (catLower.includes("ipo") || catLower.includes("fpo")) {
    tags.add("Stock");
    tags.add("Trending");
  } else if (catLower.includes("financial")) {
    tags.add("Stock");
    tags.add("Economy");
  } else if (catLower.includes("dividend")) {
    tags.add("Stock");
    tags.add("Investor");
  } else {
    tags.add("Stock");
  }

  const base = {
    author_name: "NEPSE Trading",
    tags: Array.from(tags),
    thumbnail_url: detail.image || "", // placeholder until image upload flow is added
    _internal_category: detail.category || "", // for your local filtering only — not posted
  };

  // If vision produced a structured article, prefer it over the HTML-summary fallback.
  if (visionOverride) {
    return {
      ...base,
      english_title: visionOverride.english_title || "",
      english_summary: visionOverride.english_summary || "",
      english_content: visionOverride.english_content || "",
      nepali_title: visionOverride.nepali_title || "",
      nepali_summary: visionOverride.nepali_summary || "",
      nepali_content: visionOverride.nepali_content || "",
    };
  }

  if (langMode === "english") {
    return {
      ...base,
      english_title: englishTitle,
      english_summary: englishSummary,
      english_content: englishContent,
      nepali_title: "",
      nepali_summary: "",
      nepali_content: "",
    };
  }

  if (langMode === "nepali") {
    return {
      ...base,
      english_title: "",
      english_summary: "",
      english_content: "",
      nepali_title: `[नेपालीमा अनुवाद गर्नुहोस्] ${englishTitle}`,
      nepali_summary: `[नेपालीमा अनुवाद गर्नुहोस्] ${englishSummary}`,
      nepali_content: `<p>[नेपालीमा अनुवाद गर्नुहोस्]</p>\n${englishContent}`,
    };
  }

  // mix
  return {
    ...base,
    english_title: englishTitle,
    english_summary: englishSummary,
    english_content: englishContent,
    nepali_title: `[TRANSLATE] ${englishTitle}`,
    nepali_summary: `[TRANSLATE] ${englishSummary}`,
    nepali_content: `<p>[TRANSLATE THIS SECTION]</p>\n${englishContent}`,
  };
}

// ─── Main ───
async function main() {
  console.log("\n📰 ShareSansar News Fetcher\n");

  const count = await askCount();
  const langMode = await askLanguage();
  const useVision = await askVision();

  let geminiKey = null;
  if (useVision) {
    geminiKey = await getGeminiKey();
    if (!geminiKey) {
      console.log("   ⚠️  No API key provided — vision disabled for this run.");
    } else {
      console.log(
        `   🎨 Vision enabled — ~${count} call(s) to Gemini 2.5 Flash (free tier: 10 req/min, 500 req/day).`
      );
    }
  }
  closeRL(); // no more prompts — release stdin so fetches can run cleanly

  console.log(`\n⏳ Fetching announcement list from ${LIST_URL} ...`);
  const listRes = await fetch(LIST_URL, { headers: { "User-Agent": UA } });
  if (!listRes.ok) {
    console.error(`❌ Failed to fetch list (${listRes.status})`);
    process.exit(1);
  }
  const listHtml = await listRes.text();

  const items = parseAnnouncementList(listHtml, count);
  if (items.length === 0) {
    console.error("❌ Could not parse any announcements from the list page.");
    console.error("   ShareSansar may have changed their HTML structure.");
    process.exit(1);
  }

  console.log(`✅ Found ${items.length} announcement(s)\n`);

  const news = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const short = it.title.substring(0, 70);
    process.stdout.write(`   [${i + 1}/${items.length}] ${short}... `);

    try {
      const detailRes = await fetch(it.url, { headers: { "User-Agent": UA } });
      if (!detailRes.ok) {
        console.log(`❌ (${detailRes.status})`);
        continue;
      }
      const detailHtml = await detailRes.text();
      const detail = parseDetailPage(detailHtml, it.title);

      let visionOverride = null;
      if (geminiKey && detail.image) {
        try {
          visionOverride = await generateArticleFromImage({
            imageUrl: detail.image,
            langMode,
            category: detail.category,
            apiKey: geminiKey,
          });
        } catch (ve) {
          // Per-item fallback — log on a new line so long error messages are readable.
          console.log("");
          console.log(`      ⚠️  vision fallback: ${ve.message.substring(0, 500)}`);
          process.stdout.write(`      continuing with HTML summary... `);
          visionOverride = null;
        }
      }

      news.push(buildNews({ detail, langMode, listItem: it, visionOverride }));
      console.log(visionOverride ? "✅ 🎨" : "✅");
    } catch (e) {
      console.log(`❌ (${e.message})`);
    }

    // Polite delay. Longer when vision is on to stay under Gemini 2.5 Flash's 10 req/min free-tier cap.
    const delayMs = geminiKey ? 7000 : 250;
    await new Promise((r) => setTimeout(r, delayMs));
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(news, null, 2), "utf-8");
  console.log(`\n✅ ${news.length} news item(s) written to ${path.basename(OUTPUT_FILE)}`);
  console.log(`📝 Review the file, then run: node batch-post-news.js\n`);
}

main().catch((e) => {
  console.error("\nFatal error:", e.message);
  process.exit(1);
});
