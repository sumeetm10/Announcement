// batch-post-news.js
// Posts news-to-post.json items to the NEPSE backend /news API.
// Asks for confirmation TWICE before sending anything.

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ─── Config ───
const API_BASE = "https://api.nepsetrading.com";
const DEFAULT_FILE = path.join(__dirname, "news-to-post.json");
const DELAY_MS = 800;

// ─── CLI args ───
const args = process.argv.slice(2);
const getArg = (name) => {
  const a = args.find((a) => a.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const filePath = getArg("file") || DEFAULT_FILE;
const dryRun = hasFlag("dry-run");
const delay = parseInt(getArg("delay") || DELAY_MS, 10);
// --auto: bypass both confirmation prompts. Intended for use by
// auto-post-announcements.js running under Windows Task Scheduler — where
// stdin isn't a TTY and the script needs to run unattended.
// Implies the caller has already done any human review they wanted to do.
const autoMode = hasFlag("auto");

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

// Programmatic login — POST /auth/login with email + password.
//
// The pasted-cookie JWT is a recurring single point of failure: it expires
// silently, stages 1-2 of the pipeline keep succeeding, and only the post step
// dies (see the vault note "Announcement pipeline silently stops posting when
// the .jwt expires"). Under GitHub Actions nobody is watching the log, so a
// static token is not viable. Logging in per run mints a fresh token every time.
//
// Returns {"status":"success","access_token":"..."} when the account has MFA
// off, or {"requires_mfa":true,"pending_token":"..."} when it is on — the
// headless path cannot satisfy a TOTP challenge, so that case fails loudly
// rather than silently falling through to an expired token.
async function loginForJwt(email, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `login failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`
    );
  }
  if (json.requires_mfa) {
    throw new Error(
      "login returned requires_mfa — this account has TOTP enabled and cannot " +
        "be used headlessly. Disable MFA on the poster account, or supply BLOG_JWT."
    );
  }
  const token = json.access_token;
  if (!token) throw new Error(`login response had no access_token: ${JSON.stringify(json).slice(0, 200)}`);
  return token;
}

// ─── JWT chain: env → login → --jwt=... → .jwt file → prompt ───
async function getJwt() {
  if (process.env.BLOG_JWT) {
    console.log("🔑 Using JWT from BLOG_JWT env var");
    return process.env.BLOG_JWT;
  }
  // Ahead of the .jwt file so CI never silently falls back to a stale token
  // that happens to be sitting on disk.
  if (process.env.NEPSE_EMAIL && process.env.NEPSE_PASSWORD) {
    console.log("🔑 Logging in as", process.env.NEPSE_EMAIL, "for a fresh JWT");
    return await loginForJwt(process.env.NEPSE_EMAIL, process.env.NEPSE_PASSWORD);
  }
  const cliJwt = getArg("jwt");
  if (cliJwt) {
    console.log("🔑 Using JWT from --jwt arg");
    return cliJwt;
  }
  const jwtFile = path.join(__dirname, ".jwt");
  if (fs.existsSync(jwtFile)) {
    const tok = fs.readFileSync(jwtFile, "utf-8").trim();
    if (tok) {
      console.log("🔑 Using JWT from .jwt file");
      return tok;
    }
  }
  const answer = await prompt(
    "🔑 Paste your JWT (browser DevTools > Application > Cookies > jwt): "
  );
  const tok = answer.trim();
  fs.writeFileSync(jwtFile, tok, "utf-8");
  console.log("   Saved to .jwt for next run");
  return tok;
}

// ─── Build JSON body matching Rust CreateNewsDto ───
// Required (String): author_name, nepali_title, nepali_summary, nepali_content,
//                    english_title, english_summary, english_content
// Required (Vec<String>): tags
// Optional: thumb_nail (backend uses unwrap_or_default() — see news.rs:55),
//           insider (bool)
function buildJsonBody(news) {
  const body = {
    author_name: String(news.author_name ?? ""),
    english_title: String(news.english_title ?? ""),
    english_summary: String(news.english_summary ?? ""),
    english_content: String(news.english_content ?? ""),
    nepali_title: String(news.nepali_title ?? ""),
    nepali_summary: String(news.nepali_summary ?? ""),
    nepali_content: String(news.nepali_content ?? ""),
    tags: Array.isArray(news.tags) ? news.tags.map(String) : [],
    thumb_nail: String(news.thumbnail_url ?? ""),
  };
  return body;
}

// ─── Post one news item ───
async function postOne(news, jwt, index, total) {
  const titleDisplay = news.english_title || news.nepali_title || "(untitled)";
  const label = `[${index}/${total}] "${titleDisplay.substring(0, 60)}..."`;

  if (dryRun) {
    console.log(`✅ ${label} — DRY RUN (skipped)`);
    return { ok: true, title: titleDisplay };
  }

  const body = buildJsonBody(news);
  const res = await fetch(`${API_BASE}/news`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let json;
  try {
    json = await res.json();
  } catch {
    json = { raw: await res.text().catch(() => "") };
  }

  if (!res.ok) {
    console.log(
      `❌ ${label} — status:${res.status} ${JSON.stringify(json).substring(0, 150)}`
    );
    return { ok: false, error: json, title: titleDisplay, status: res.status };
  }

  const slug = json?.news?.slug || json?.data?.slug || "?";
  const id = json?.news?.id || json?.data?.id || "?";
  console.log(`✅ ${label} — ID:${id} | slug:${slug}`);
  return { ok: true, id, slug, title: titleDisplay };
}

// ─── Show preview table ───
function printPreview(items) {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`PREVIEW: ${items.length} news item(s) to post`);
  console.log("─".repeat(72));
  items.forEach((n, i) => {
    const t = n.english_title || n.nepali_title || "(untitled)";
    const cat = n._internal_category || "-";
    const img = n.thumbnail_url ? "img" : " - ";
    const tags = Array.isArray(n.tags) ? n.tags.join(",") : "";
    console.log(`${String(i + 1).padStart(2)}. [${img}] [${cat}] ${t.substring(0, 55)}`);
    console.log(`     tags: ${tags}`);
  });
  console.log("─".repeat(72));
}

// ─── Main ───
async function main() {
  console.log("\n📰 News Batch Poster\n");

  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    console.error(`   Run "node fetch-news.js" first.`);
    process.exit(1);
  }

  let items;
  try {
    items = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.error(`❌ Invalid JSON: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(items) || items.length === 0) {
    console.error("❌ news-to-post.json must be a non-empty array");
    process.exit(1);
  }

  console.log(`📄 Loaded ${items.length} item(s) from ${path.basename(filePath)}`);
  if (dryRun) console.log("🔍 DRY RUN mode — no API calls will be made");

  // ─── PREVIEW + FIRST CONFIRMATION ───
  printPreview(items);
  if (autoMode) {
    console.log(`\n[auto] Skipping both confirmations (--auto). Proceeding to post ${items.length} item(s).`);
  } else {
    const c1 = (await prompt(
      `\n❓ CONFIRM 1/2: Does the preview look correct? (yes/no): `
    )).toLowerCase();
    if (c1 !== "yes" && c1 !== "y") {
      console.log("Aborted at confirmation 1. Nothing was posted.");
      process.exit(0);
    }

    // ─── SECOND CONFIRMATION ───
    const c2 = await prompt(
      `❓ CONFIRM 2/2: Type 'POST ${items.length}' exactly to publish all ${items.length} news items: `
    );
    if (c2 !== `POST ${items.length}`) {
      console.log("Aborted at confirmation 2. Nothing was posted.");
      process.exit(0);
    }
  }

  // ─── JWT ───
  const jwt = dryRun ? "dry-run" : await getJwt();

  if (!dryRun) {
    console.log("🔄 Validating JWT against /auth/me ...");
    const testRes = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (testRes.status === 401) {
      console.error("❌ JWT is invalid or expired.");
      console.error("   1) Log into https://nepsetrading.com in your browser");
      console.error("   2) DevTools > Application > Cookies > copy the 'jwt' value");
      console.error("   3) Overwrite the .jwt file in this folder, OR delete .jwt and re-run");
      process.exit(1);
    }
    if (testRes.status >= 400) {
      console.error(`❌ /auth/me returned status ${testRes.status}`);
      process.exit(1);
    }
    // Check role: POST /news requires 'admin' or 'admin_news'
    try {
      const me = await testRes.json();
      const roles = me?.roles || me?.data?.roles || [];
      const ok = roles.includes("admin") || roles.includes("admin_news");
      if (!ok) {
        console.error(
          `❌ Your user is authenticated but lacks 'admin' or 'admin_news' role (roles: ${JSON.stringify(roles)}).`
        );
        console.error("   Ask an admin to grant you the 'admin_news' role.");
        process.exit(1);
      }
    } catch {
      // fall through — role check is best-effort
    }
    console.log("✅ JWT valid\n");
  }

  // No more prompts needed — release stdin
  closeRL();

  // ─── Post ───
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const r = await postOne(items[i], jwt, i + 1, items.length);
    results.push(r);
    if (i < items.length - 1 && !dryRun) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ─── Summary ───
  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`✅ Posted: ${ok}  |  ❌ Failed: ${fail}  |  Total: ${results.length}`);
  if (fail > 0) {
    console.log("\nFailed:");
    results
      .filter((r) => !r.ok)
      .forEach((r) =>
        console.log(
          `  - [${r.status || "?"}] ${r.title.substring(0, 60)}: ${JSON.stringify(
            r.error
          ).substring(0, 100)}`
        )
      );
  }
  if (ok > 0 && !dryRun) {
    console.log("\nPosted:");
    results
      .filter((r) => r.ok)
      .forEach((r) => console.log(`  ID:${r.id} | ${r.slug}`));
  }
  console.log();
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});
