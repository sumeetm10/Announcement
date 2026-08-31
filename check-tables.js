// Regression suite for the announcement table/header reconstruction.
//
//   node check-tables.js
//
// Runs every fixture in table-fixtures/ through the REAL pipeline
// (fetch-announcements.js --classify-test, no network, no Gemini key) and
// compares the <table> / <thead> counts against table-fixtures/expected.json.
// Exit code 1 on any mismatch.
//
// Run this after ANY change to classifyLine, isTableHeaderRowLine,
// isBridgeLabel, headerCells or detectFinancialTables. The header heuristics
// are mutually load-bearing: loosening a weak marker to rescue one notice has
// twice turned ordinary prose into a table header, and tightening a section
// band has twice shattered a balance sheet into one table per section. The
// adversarial fixtures (prose, adv, adv2) exist to catch the first failure mode
// and caps exists to catch the second - a change that "fixes" a real notice
// while breaking those is not a fix.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "table-fixtures");
const SCRAPER = path.join(__dirname, "fetch-announcements.js");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));

let fail = 0;
let pass = 0;
for (const name of Object.keys(expected)) {
  if (name.startsWith("_")) continue;
  const file = path.join(DIR, `${name}.txt`);
  if (!fs.existsSync(file)) {
    console.log(`MISSING  ${name}.txt`);
    fail++;
    continue;
  }
  let out = "";
  try {
    out = execFileSync("node", [SCRAPER, `--classify-test=${file}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    console.log(`CRASH    ${name}: ${(e.message || "").split("\n")[0]}`);
    fail++;
    continue;
  }
  const html = out.slice(out.indexOf("--- HTML ---"));
  const tables = (html.match(/<table>/g) || []).length;
  const thead = (html.match(/<thead>/g) || []).length;
  const want = expected[name];
  if (tables === want.tables && thead === want.thead) {
    pass++;
  } else {
    fail++;
    console.log(
      `FAIL     ${name}: got tables=${tables} thead=${thead}, ` +
        `want tables=${want.tables} thead=${want.thead}  (${want.note})`
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
