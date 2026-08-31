// delete-news.js
// Deletes news items from the NEPSE backend. Two confirmations required.
// Designed for cleaning up posts created by fetch-onlinekhabar.js and
// watch-live-blog.js.
//
//   node delete-news.js                    → list all news with default tag, interactive delete
//   node delete-news.js --tag="<tag>"      → use a different tag
//   node delete-news.js --slug=<slug>      → delete just one slug
//   node delete-news.js --slugs=a,b,c      → delete a specific list of slugs
//   node delete-news.js --dry-run          → preview only, no API calls
//
// Default tag: "नीति तथा कार्यक्रम" (matches the tag fetch-onlinekhabar.js applies)

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const API_BASE = "https://api.nepsetrading.com";
const JWT_FILE = path.join(__dirname, ".jwt");
const DEFAULT_TAG = "नीति तथा कार्यक्रम";

const args = process.argv.slice(2);
const getArg = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const TAG = getArg("tag") || DEFAULT_TAG;
const SINGLE_SLUG = getArg("slug");
const SLUGS_LIST = getArg("slugs");
const DRY_RUN = hasFlag("dry-run");

let _rl;
function prompt(q) {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => _rl.question(q, (a) => r(a.trim())));
}
function closeRL() {
  if (_rl) {
    _rl.close();
    _rl = null;
  }
}

function readJwt() {
  if (!fs.existsSync(JWT_FILE)) {
    throw new Error(".jwt file not found. Run batch-post-news.js once to seed it.");
  }
  return fs.readFileSync(JWT_FILE, "utf-8").trim();
}

async function listByTag(tag) {
  const url = `${API_BASE}/news?tags=${encodeURIComponent(tag)}&limit=100&latest=true`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`list ${r.status}: ${(await r.text()).substring(0, 200)}`);
  const j = await r.json();
  return Array.isArray(j.data) ? j.data : [];
}

async function deleteOne(slug, jwt) {
  if (!slug || slug.trim() === "") {
    throw new Error("empty slug — backend DELETE requires a non-empty slug path segment");
  }
  const r = await fetch(`${API_BASE}/news/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text.substring(0, 250)}`);
  return text;
}

async function main() {
  console.log("\n🗑️  News deletion tool\n");

  let toDelete = [];

  if (SINGLE_SLUG) {
    toDelete = [{ slug: SINGLE_SLUG, id: "?", nepali_title: "(by --slug arg)" }];
    console.log(`Mode: single slug = ${SINGLE_SLUG}`);
  } else if (SLUGS_LIST) {
    toDelete = SLUGS_LIST.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ slug: s, id: "?", nepali_title: "(by --slugs arg)" }));
    console.log(`Mode: ${toDelete.length} slug(s) from --slugs`);
  } else {
    console.log(`Mode: list by tag = "${TAG}"`);
    toDelete = await listByTag(TAG);
    if (toDelete.length === 0) {
      console.log(`No news with tag "${TAG}". Nothing to delete.`);
      return;
    }
  }

  console.log(`\n${"─".repeat(72)}`);
  console.log(`PREVIEW: ${toDelete.length} news item(s) marked for DELETION`);
  console.log("─".repeat(72));
  toDelete.forEach((n, i) => {
    const title =
      (n.nepali_title && n.nepali_title.trim()) ||
      n.english_title ||
      "(untitled)";
    const tags = Array.isArray(n.tags) ? n.tags.join(", ") : "";
    const slug = n.slug || "(empty)";
    console.log(`${String(i + 1).padStart(2)}. ID:${n.id || "?"}`);
    console.log(`    slug:  ${slug}`);
    console.log(`    title: ${title.substring(0, 80)}`);
    if (tags) console.log(`    tags:  ${tags}`);
  });
  console.log("─".repeat(72));

  if (DRY_RUN) {
    console.log("\n🔍 DRY RUN — exiting without delete.");
    return;
  }

  const c1 = (
    await prompt(`\n❓ CONFIRM 1/2: Delete these ${toDelete.length} item(s)? (yes/no): `)
  ).toLowerCase();
  if (c1 !== "yes" && c1 !== "y") {
    console.log("Aborted at confirmation 1. Nothing deleted.");
    return;
  }
  const c2 = await prompt(
    `❓ CONFIRM 2/2: Type 'DELETE ${toDelete.length}' exactly to proceed: `
  );
  if (c2 !== `DELETE ${toDelete.length}`) {
    console.log("Aborted at confirmation 2. Nothing deleted.");
    return;
  }
  closeRL();

  const jwt = readJwt();
  console.log("\nDeleting...");
  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < toDelete.length; i++) {
    const n = toDelete[i];
    const label = `[${i + 1}/${toDelete.length}]`;
    try {
      await deleteOne(n.slug, jwt);
      console.log(`✅ ${label} deleted slug=${n.slug}`);
      okCount++;
    } catch (e) {
      console.log(`❌ ${label} slug=${n.slug || "(empty)"} → ${e.message.substring(0, 200)}`);
      failCount++;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`✅ Deleted: ${okCount}  |  ❌ Failed: ${failCount}  |  Total: ${toDelete.length}`);
  if (okCount > 0) {
    console.log(
      `\nNote: backend list-cache has a 60s TTL. Frontend may still show the deleted items for up to a minute.`
    );
    console.log("\nLocal state files that may also need clearing:");
    console.log(
      "  node watch-live-blog.js --reset      # clears live-blog-state.json so next run POSTs fresh"
    );
    console.log(
      "  node fetch-onlinekhabar.js --reset   # clears the RSS queue"
    );
    console.log(
      "  del seen-onlinekhabar.json           # forgets RSS dedup so the same items can be re-fetched"
    );
  }
  console.log();
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
