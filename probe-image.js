// probe-image.js
// Downloads a ShareSansar announcement image and prints its dimensions +
// aspect ratio WITHOUT calling Gemini. Used to figure out what layout
// ShareSansar serves for multi-page notices (tall stacked, wide grid,
// single page, etc.) so we can build the right kind of image splitter.
//
// Usage:
//   node probe-image.js https://www.sharesansar.com/announcementdetail/<slug>

const sharp = require("sharp");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,*/*",
  "Accept-Language": "en-US,en;q=0.9,ne;q=0.8",
};

// Same image-extraction probes as fetch-announcements.js. Tries each
// selector pattern in order; returns the first match.
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

async function main() {
  const url = process.argv[2];
  if (!url || !/^https?:\/\/(www\.)?sharesansar\.com\/announcementdetail\//i.test(url)) {
    console.error("Usage: node probe-image.js <sharesansar announcementdetail URL>");
    process.exit(1);
  }

  console.log(`Fetching detail page: ${url}`);
  const detailRes = await fetch(url, { headers: BROWSER_HEADERS });
  if (!detailRes.ok) {
    console.error(`Detail page returned ${detailRes.status}`);
    process.exit(1);
  }
  const html = await detailRes.text();
  const imgUrl = findImageUrl(html);
  if (!imgUrl) {
    console.error("No notice image found on detail page (HTML structure may have changed).");
    process.exit(1);
  }

  console.log(`Image URL:    ${imgUrl}`);
  const imgRes = await fetch(imgUrl, { headers: { "User-Agent": UA } });
  if (!imgRes.ok) {
    console.error(`Image fetch returned ${imgRes.status}`);
    process.exit(1);
  }
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
  const sizeKB = (imgBuf.length / 1024).toFixed(1);
  console.log(`Image size:   ${sizeKB} KB`);

  const meta = await sharp(imgBuf).metadata();
  const aspect = (meta.height || 0) / (meta.width || 1);
  console.log(`Image format: ${meta.format}`);
  console.log(`Dimensions:   ${meta.width} × ${meta.height} px`);
  console.log(`Aspect ratio: ${aspect.toFixed(2)}  (height ÷ width)`);

  console.log("\nInterpretation:");
  if (aspect > 2.5) {
    console.log("  → Tall stacked layout. Multiple pages arranged vertically.");
    console.log("  → Vertical splitter SHOULD trigger and slice into chunks.");
  } else if (aspect > 1.6) {
    console.log("  → Single tall page (e.g. A4 portrait). No split needed.");
    console.log("  → Gemini should handle this at full resolution.");
  } else if (aspect > 0.9) {
    console.log("  → Near-square or wide single page.");
    console.log("  → No split needed; Gemini sees the whole thing.");
  } else if (aspect > 0.4) {
    console.log("  → Wider than tall — likely multiple pages laid out SIDE-BY-SIDE in columns.");
    console.log("  → Vertical splitter WON'T help (would cut through columns).");
    console.log("  → Need HORIZONTAL splitter (split into left/right page groups).");
  } else {
    console.log("  → Very wide layout — probably a panoramic multi-column arrangement.");
    console.log("  → Needs horizontal column splitting + maybe vertical too.");
  }
  console.log("\nNo Gemini API calls were made.");
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
