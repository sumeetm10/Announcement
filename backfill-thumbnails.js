// backfill-thumbnails.js
// Updates existing Announcement posts on the backend to set thumbnail_url
// based on their category — for posts that were created BEFORE the cron
// pipeline started auto-populating the thumbnail field.
//
// Reads the same category-image resolver that fetch-announcements.js uses,
// so the URLs match exactly what new posts get going forward.
//
// Usage:
//   node backfill-thumbnails.js              → interactive, asks before each update
//   node backfill-thumbnails.js --auto       → no prompts, update everything that needs it
//   node backfill-thumbnails.js --dry-run    → preview only, no API calls
//   node backfill-thumbnails.js --force      → re-update even items that already have a thumbnail
//
// Authentication: reads JWT from .jwt file (same as batch-post-news.js).

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const API_BASE = "https://api.nepsetrading.com";
const JWT_FILE = path.join(__dirname, ".jwt");
const ANNOUNCEMENT_TAG = "Announcement";

// ─── CLI args ───
const args = process.argv.slice(2);
const hasFlag = (n) => args.includes(`--${n}`);
const dryRun = hasFlag("dry-run");
const autoMode = hasFlag("auto");
const force = hasFlag("force");

// ─── Category-image resolution (mirrors fetch-announcements.js) ───
const FRONTEND_BASE_URL = "https://nepsetrading.com";
const CATEGORY_IMAGE_BASE = "/announcements/categories";
// WebP extension — must match fetch-announcements.js + frontend helper.
const CATEGORY_IMAGE_EXT = "webp";

const SHIPPED_CATEGORY_IMAGES = new Set([
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

function slugifyCategory(c) {
  if (!c) return "";
  return String(c).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveCategoryImageUrl(category) {
  const slug = slugifyCategory(category);
  let chosen = "";
  if (slug) {
    if (SHIPPED_CATEGORY_IMAGES.has(slug)) {
      chosen = slug;
    } else {
      const aliases = CATEGORY_ALIASES[slug];
      if (aliases) chosen = aliases.find((a) => SHIPPED_CATEGORY_IMAGES.has(a)) || "";
    }
  }
  if (!chosen && SHIPPED_CATEGORY_IMAGES.has("default")) chosen = "default";
  if (!chosen) return "";
  return `${FRONTEND_BASE_URL}${CATEGORY_IMAGE_BASE}/${chosen}.${CATEGORY_IMAGE_EXT}`;
}

// ─── readline helpers ───
let _rl;
function prompt(q) {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => _rl.question(q, (a) => r(a.trim())));
}
function closeRL() { if (_rl) { _rl.close(); _rl = null; } }

// ─── Main ───
async function main() {
  console.log("\n🖼  Backfill thumbnail_url on Announcement posts\n");
  if (dryRun) console.log("(DRY RUN — no API calls will be made)\n");

  // 1. Fetch all Announcement posts (up to 200 — adjust if needed)
  const listUrl = `${API_BASE}/news?tags=${encodeURIComponent(ANNOUNCEMENT_TAG)}&limit=200&latest=true`;
  console.log(`Fetching posts from ${listUrl} ...`);
  const r = await fetch(listUrl);
  if (!r.ok) {
    console.error(`Failed to fetch list (${r.status})`);
    process.exit(1);
  }
  const j = await r.json();
  const items = Array.isArray(j.data) ? j.data : [];
  console.log(`Found ${items.length} Announcement post(s).\n`);

  // 2. Compute the target thumbnail URL for each, identify which need updating
  const toUpdate = [];
  for (const item of items) {
    const category = Array.isArray(item.tags) ? item.tags.find((t) => t && t !== ANNOUNCEMENT_TAG) : "";
    const targetUrl = resolveCategoryImageUrl(category);
    if (!targetUrl) {
      // No image to set for this category (and no default shipped) — skip.
      continue;
    }
    const currentUrl = item.thumbNail || "";
    if (currentUrl === targetUrl) {
      // Already correct — skip.
      continue;
    }
    if (currentUrl && !force) {
      // Item already has SOME thumbnail (probably manually uploaded) — preserve
      // it unless --force is passed. The manually-uploaded one likely has
      // editorial intent we shouldn't overwrite.
      console.log(`  [skip] ${item.slug}: already has thumbnail (use --force to overwrite)`);
      continue;
    }
    toUpdate.push({ item, targetUrl, category });
  }

  if (toUpdate.length === 0) {
    console.log("Nothing to update — all posts already have correct thumbnails.");
    closeRL();
    return;
  }

  console.log(`\n${toUpdate.length} post(s) need a thumbnail update:`);
  toUpdate.forEach((u, i) => {
    const t = u.item.english_title || u.item.nepali_title || "(untitled)";
    console.log(`  ${i + 1}. [${u.category || "(no category)"}] ${t.substring(0, 60)}`);
    console.log(`     slug: ${u.item.slug}`);
    console.log(`     →   : ${u.targetUrl}`);
  });

  // 3. Confirm + update
  if (!dryRun && !autoMode) {
    const ans = await prompt(`\nProceed with ${toUpdate.length} updates? (yes/no): `);
    if (ans.toLowerCase() !== "yes") {
      console.log("Aborted.");
      closeRL();
      return;
    }
  }
  closeRL();

  if (dryRun) {
    console.log("\nDRY RUN complete. No updates made.");
    return;
  }

  // Read JWT for PATCH calls
  if (!fs.existsSync(JWT_FILE)) {
    console.error(`\n❌ .jwt file not found at ${JWT_FILE}. Run batch-post-news.js once to seed it.`);
    process.exit(1);
  }
  const jwt = fs.readFileSync(JWT_FILE, "utf-8").trim();

  let ok = 0, fail = 0;
  for (let i = 0; i < toUpdate.length; i++) {
    const { item, targetUrl } = toUpdate[i];
    const label = `[${i + 1}/${toUpdate.length}] ${item.slug.substring(0, 60)}`;

    // Backend expects PATCH /news/<slug> or similar. The exact endpoint may
    // vary — adjust if your backend uses a different update route.
    const patchUrl = `${API_BASE}/news/${encodeURIComponent(item.slug)}`;
    const res = await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ thumb_nail: targetUrl }),
    });
    if (res.ok) {
      console.log(`✅ ${label}`);
      ok++;
    } else {
      const errText = await res.text().catch(() => "");
      console.log(`❌ ${label} — status:${res.status} ${errText.substring(0, 150)}`);
      fail++;
    }

    // Be polite — 200ms between calls
    if (i < toUpdate.length - 1) await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n────────────────────────────────────────────`);
  console.log(`✅ Updated: ${ok}  |  ❌ Failed: ${fail}  |  Total: ${toUpdate.length}`);
}

main().catch((e) => {
  console.error("\nFatal:", e.message);
  process.exit(1);
});
