// prepare-announcement.js
// Takes a ShareSansar announcement URL + OCR output you produced manually
// (e.g. via Google Drive's "Open with Google Docs" OCR) and writes a
// news-announcements.json entry ready for batch-post-news.js.
//
// Accepts TWO input formats:
//   • .txt — plain text (each line becomes its own <p> after letterhead strip).
//            Best for short prose-only notices.
//   • .html — Google Docs export (File → Download → Web Page (.html, zipped)).
//            PRESERVES TABLES. Strongly recommended for financial notices.
//
// Usage:
//   node prepare-announcement.js "<ShareSansar URL>" ocr-shikhar.txt
//   node prepare-announcement.js "<ShareSansar URL>" ocr-shikhar.html
//
// Output: news-announcements.json (appends or replaces by title).
// Post with: node batch-post-news.js --file=news-announcements.json

const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,ne;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const ANNOUNCEMENT_TAG = "Announcement";
const OUTPUT_FILE = path.join(__dirname, "news-announcements.json");

// ─── HTML helpers ───
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── ShareSansar parsing ───
async function fetchSharesansarDetail(url) {
  const r = await fetch(url, { headers: BROWSER_HEADERS });
  if (!r.ok) throw new Error(`page fetch ${r.status}`);
  const html = await r.text();
  const titleMatch = html.match(
    /<h1[^>]*style="font-size:\s*30px[^"]*"[^>]*>([\s\S]*?)<\/h1>/
  );
  const title = titleMatch ? stripTags(titleMatch[1]) : "";
  const categoryMatch = html.match(/class="tags"[^>]*>([\s\S]*?)<\/a>/);
  const category = categoryMatch ? stripTags(categoryMatch[1]) : "";
  const contentMatch = html.match(/<div id="newsdetail-content">([\s\S]*?)<\/div>/);
  const summary = contentMatch ? stripTags(contentMatch[1]) : "";
  return { title, category, summary };
}

// ─── OCR text formatting ───
//
// Strategy: each non-empty line from the OCR becomes its own <p>. Cleanup:
//   - drop fully-blank lines
//   - drop lines that are just punctuation/dashes (OCR layout debris)
//   - collapse runs of whitespace within a line to a single space
//   - strip leading letterhead block (company name + address + phone/email)
//   - strip trailing letterhead block (issue manager contact info)
//
// Letterhead strategy: scan the first/last N lines for an end-marker
// (Phone, Fax, Email, Tel, Website, P.O.Box, or an email address) and
// drop everything up to and including the LAST such marker (leading) or
// the FIRST such marker (trailing).
const LETTERHEAD_SCAN_LINES = 15;
const LETTERHEAD_END_MARKERS = [
  /^(phone|fax|email|e-mail|tel|tel\.|mobile|mob\.|web|website|url)\s*[:\-]/i,
  /\b(phone|fax|email|tel|website|url)\s*[:\-]\s*\S/i,
  /[@][a-z0-9.-]+\.[a-z]{2,}/i,
  /^p\.?\s*o\.?\s*box\b/i,
  /^(post\s*box|gpo|g\.p\.o)\b/i,
];

function looksLikeLetterheadEnd(line) {
  return LETTERHEAD_END_MARKERS.some((re) => re.test(line));
}

function stripLetterheadBlocks(lines) {
  let result = lines;

  // Leading: find LAST end-marker in the first N lines, drop everything ≤ it
  const leadLimit = Math.min(result.length, LETTERHEAD_SCAN_LINES);
  let leadEnd = -1;
  for (let i = 0; i < leadLimit; i++) {
    if (looksLikeLetterheadEnd(result[i])) leadEnd = i;
  }
  if (leadEnd >= 0) result = result.slice(leadEnd + 1);

  // Trailing: find FIRST end-marker in the last N lines, drop from there to end
  const tailStart = Math.max(0, result.length - LETTERHEAD_SCAN_LINES);
  let trailStart = -1;
  for (let i = tailStart; i < result.length; i++) {
    if (looksLikeLetterheadEnd(result[i])) {
      trailStart = i;
      break;
    }
  }
  if (trailStart >= 0) result = result.slice(0, trailStart);

  return result;
}

function cleanOcrLines(rawText) {
  let lines = rawText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^[\s\-–—=_.,:;|]+$/.test(l));
  lines = stripLetterheadBlocks(lines);
  return lines;
}

function formatOcrAsHtml(rawText) {
  const lines = cleanOcrLines(rawText);
  return lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n");
}

// ─── HTML input (Google Docs export) ───
//
// Google Docs exports preserve table structure: <table>, <tr>, <td> stay
// intact, paragraphs stay as <p>, headings as <h1>-<h6>. Result reads like a
// proper document rather than a flat list of OCR lines.
//
// We extract the <body>, then sanitize aggressively:
//   - strip <script>/<style>/<head>/<!--...-->
//   - strip <img> (Google Docs embeds the original image as base64; huge)
//   - strip all attributes (class, style, id, dir, lang, colspan, etc.)
//     -- keep only colspan/rowspan on td/th for table layout
//   - remove <span>/<a> wrappers (Google Docs nests styling spans heavily)
//   - drop empty paragraphs and <span></span> remnants
//
// Result: clean structural HTML safe to post directly as nepali_content.
const ALLOWED_TAGS = new Set([
  "p", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "strong", "em", "b", "i", "u",
  "br", "hr",
]);

function processHtmlInput(htmlText) {
  let body = htmlText;
  const bodyMatch = htmlText.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1];

  // Strip script/style/head/comments/images entirely (including content)
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<img[^>]*>/gi, "");

  // Remove <span> wrappers (keep content). Google Docs wraps every text run
  // in span(s) with inline styles — strip them entirely.
  body = body.replace(/<\/?span[^>]*>/gi, "");

  // Remove <a> wrappers, keep their text content
  body = body.replace(/<a[^>]*>/gi, "").replace(/<\/a>/gi, "");

  // Strip attributes from allowed tags except colspan/rowspan on td/th
  body = body.replace(/<(\/?)(\w+)([^>]*)>/g, (match, slash, tagRaw, attrs) => {
    const tag = tagRaw.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return ""; // disallowed tag — strip entirely
    if (slash) return `</${tag}>`;
    if (tag === "td" || tag === "th") {
      // preserve colspan/rowspan only
      const keep = [];
      const colspan = attrs.match(/\bcolspan\s*=\s*["']?(\d+)/i);
      const rowspan = attrs.match(/\browspan\s*=\s*["']?(\d+)/i);
      if (colspan) keep.push(`colspan="${colspan[1]}"`);
      if (rowspan) keep.push(`rowspan="${rowspan[1]}"`);
      return keep.length ? `<${tag} ${keep.join(" ")}>` : `<${tag}>`;
    }
    return `<${tag}>`;
  });

  // Drop empty paragraphs and tighten whitespace
  body = body
    .replace(/<p>\s*<\/p>/gi, "")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();

  return body;
}

function isHtmlFile(filename) {
  return /\.html?$/i.test(filename);
}

function deriveSummary(rawText, max = 220) {
  // Build summary from the cleaned (letterhead-stripped) text so we don't
  // surface contact info / table debris in the preview.
  const t = cleanOcrLines(rawText).join(" ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  const cut = t.substring(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 60 ? cut.substring(0, sp) : cut) + "…";
}

function looksLikeTitleDuplicate(summary, title) {
  const norm = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
  const a = norm(summary);
  const b = norm(title);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

// ─── Main ───
async function main() {
  const [url, ocrFile] = process.argv.slice(2);
  if (!url || !ocrFile) {
    console.error("Usage: node prepare-announcement.js <ShareSansar URL> <ocr-text-file>");
    process.exit(1);
  }
  if (!fs.existsSync(ocrFile)) {
    console.error(`OCR text file not found: ${ocrFile}`);
    process.exit(1);
  }

  const rawInput = fs.readFileSync(ocrFile, "utf-8");
  const inputMode = isHtmlFile(ocrFile) ? "html" : "text";
  console.log(`Input: ${rawInput.length} chars from ${path.basename(ocrFile)} (mode: ${inputMode})`);

  console.log(`Fetching ${url} ...`);
  const detail = await fetchSharesansarDetail(url);
  if (!detail.title) {
    console.error("Could not extract title from page. URL valid?");
    process.exit(1);
  }
  console.log(`Title:    ${detail.title.substring(0, 80)}${detail.title.length > 80 ? "…" : ""}`);
  console.log(`Category: ${detail.category || "(none)"}`);

  const englishSummary = looksLikeTitleDuplicate(detail.summary, detail.title)
    ? ""
    : detail.summary;

  const tags = [ANNOUNCEMENT_TAG];
  if (detail.category && detail.category.trim()) {
    tags.push(detail.category.trim());
  }

  // HTML mode preserves tables; text mode falls back to per-line <p>.
  let nepaliContent;
  let nepaliSummary;
  if (inputMode === "html") {
    nepaliContent = processHtmlInput(rawInput);
    // Build summary from the visible text after stripping all HTML tags
    const visibleText = nepaliContent.replace(/<[^>]+>/g, " ");
    nepaliSummary = deriveSummary(visibleText);
  } else {
    nepaliContent = formatOcrAsHtml(rawInput);
    nepaliSummary = deriveSummary(rawInput);
  }

  const item = {
    author_name: "NEPSE Trading",
    tags,
    thumbnail_url: "",
    _internal_category: detail.category,
    english_title: detail.title,
    english_summary: englishSummary,
    english_content: "",
    nepali_title: detail.title,
    nepali_summary: nepaliSummary,
    nepali_content: nepaliContent,
  };

  // Append-or-replace: if news-announcements.json already exists and has
  // an entry with the same english_title, replace it; else append.
  let queue = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
      if (Array.isArray(existing)) queue = existing;
    } catch {
      queue = [];
    }
  }
  const dupIdx = queue.findIndex((q) => q.english_title === item.english_title);
  if (dupIdx >= 0) {
    queue[dupIdx] = item;
    console.log(`(Replaced existing entry at index ${dupIdx})`);
  } else {
    queue.push(item);
    console.log(`(Appended as entry ${queue.length})`);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(queue, null, 2), "utf-8");
  console.log(`\nWrote ${path.basename(OUTPUT_FILE)} — ${queue.length} item(s) total.`);
  const pCount = (item.nepali_content.match(/<p[^a-z]/gi) || []).length;
  const tableCount = (item.nepali_content.match(/<table[^a-z]/gi) || []).length;
  console.log(`Body: ${pCount} paragraph(s), ${tableCount} table(s)`);
  console.log(`\nNext: node batch-post-news.js --file=${path.basename(OUTPUT_FILE)}\n`);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
