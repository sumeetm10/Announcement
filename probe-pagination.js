// probe-pagination.js
// Tests which URL pattern ShareSansar uses for paginating the announcements
// listing. Fetches several candidate URLs and prints the FIRST 5 item URLs
// from each so we can identify which pattern returns DIFFERENT items
// (= correct pagination) vs. SAME items (= URL pattern doesn't trigger
// pagination, server returns page 1 by default).
//
// Usage:  node probe-pagination.js
// No API calls — just HTTP HTML fetches.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

const BASE = "https://www.sharesansar.com/announcement";

const CANDIDATES = [
  `${BASE}`,                    // page 1 baseline
  `${BASE}?page=2`,             // our current assumption
  `${BASE}?p=2`,                // alt param name
  `${BASE}?offset=20`,          // some sites use offset
  `${BASE}/page/2`,             // path-based
  `${BASE}/2`,                  // bare suffix
  `${BASE}?page=2&_t=${Date.now()}`, // page 2 with cache-buster
];

function extractFirstNTitles(html, n) {
  // Pull the first N (URL, title) pairs from the listing HTML.
  const blocks = html.split(/<div class="featured-news-list/).slice(1);
  const out = [];
  for (const block of blocks) {
    const hrefMatch = block.match(
      /href="(https:\/\/www\.sharesansar\.com\/announcementdetail\/[^"]+)"/
    );
    const titleMatch = block.match(
      /<h4 class="featured-announcement-title">([\s\S]*?)<\/h4>/
    );
    if (hrefMatch && titleMatch) {
      const title = titleMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      const slug = hrefMatch[1].split("/").pop();
      out.push({ slug, title: title.substring(0, 70) });
      if (out.length >= n) break;
    }
  }
  return out;
}

async function probe() {
  console.log("\nProbing ShareSansar pagination URL patterns\n" + "=".repeat(64));

  const results = [];
  for (const url of CANDIDATES) {
    process.stdout.write(`\nGET ${url}\n`);
    try {
      const r = await fetch(url, { headers: HEADERS });
      console.log(`  Status: ${r.status}`);
      if (!r.ok) {
        results.push({ url, status: r.status, items: null });
        continue;
      }
      const html = await r.text();
      const items = extractFirstNTitles(html, 5);
      if (items.length === 0) {
        console.log("  (no items found by parser — page format may differ)");
        results.push({ url, status: r.status, items: [] });
        continue;
      }
      items.forEach((it, i) => {
        console.log(`  [${i + 1}] ${it.title}`);
      });
      results.push({ url, status: r.status, items });
    } catch (err) {
      console.log(`  Error: ${err.message}`);
      results.push({ url, status: 0, items: null, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 800)); // polite delay
  }

  // Compare each candidate's first item against page-1's first item to identify
  // which pattern actually returns different content.
  console.log("\n" + "=".repeat(64));
  console.log("ANALYSIS — which pattern returns DIFFERENT items than page 1?\n");
  const page1Slug = results[0]?.items?.[0]?.slug;
  if (!page1Slug) {
    console.log("Couldn't parse page 1 — can't compare. Check HTML structure.");
    return;
  }
  console.log(`Page 1's first item: ${page1Slug}\n`);

  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    const firstSlug = r.items?.[0]?.slug;
    let verdict;
    if (r.status !== 200) {
      verdict = `❌ ${r.status} — pattern not supported`;
    } else if (!firstSlug) {
      verdict = "❌ No items parsed";
    } else if (firstSlug === page1Slug) {
      verdict = "⚠️  SAME as page 1 — this URL doesn't paginate";
    } else {
      verdict = "✅ DIFFERENT items — pagination works with this pattern!";
    }
    console.log(`${r.url}`);
    console.log(`  → ${verdict}`);
    if (firstSlug && firstSlug !== page1Slug) {
      console.log(`  First item: ${firstSlug}`);
    }
    console.log();
  }
}

probe().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

// ─── Cursor-based pagination probe ───
//
// ShareSansar paginates via a base64 `cursor` token embedded in the
// "Next »" link's href on each page. This walks page 1 → find "Next" →
// follow it → find "Next" again → etc., printing the first item URL of
// each page to confirm we get different items each time.
async function cursorProbe() {
  console.log("\n" + "=".repeat(64));
  console.log("CURSOR PAGINATION PROBE");
  console.log("=".repeat(64));

  let url = BASE;
  for (let page = 1; page <= 3; page++) {
    console.log(`\nPage ${page}: ${url}`);
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) {
      console.log(`  Status: ${r.status} — stopping`);
      break;
    }
    const html = await r.text();
    const items = extractFirstNTitles(html, 3);
    items.forEach((it, i) => console.log(`  [${i + 1}] ${it.title}`));

    // Find next link
    let nextHref = null;
    const m1 = html.match(/href="([^"]*?cursor=[^"]+)"[^>]*rel="next"/i)
      || html.match(/rel="next"[^>]*href="([^"]*?cursor=[^"]+)"/i);
    if (m1) nextHref = m1[1];
    if (!nextHref) {
      const m2 = html.match(/<a[^>]+href="([^"]*?cursor=[^"]+)"[^>]*>[^<]*?Next/i);
      if (m2) nextHref = m2[1];
    }
    if (!nextHref) {
      console.log("  → No 'Next' cursor link found, end of list");
      break;
    }
    // Decode HTML entities (&amp; → &) and resolve to absolute
    nextHref = nextHref.replace(/&amp;/g, "&");
    if (nextHref.startsWith("/")) nextHref = "https://www.sharesansar.com" + nextHref;
    console.log(`  Next href: ${nextHref.substring(0, 100)}${nextHref.length > 100 ? "..." : ""}`);
    url = nextHref;
    await new Promise((r) => setTimeout(r, 800));
  }
}

// Run the cursor probe AFTER the URL-pattern probe (which is already
// scheduled by the main() probe() call above; this is a second pass).
setTimeout(() => {
  cursorProbe().catch((err) => console.error("Cursor probe fatal:", err.message));
}, 10000);
