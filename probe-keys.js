// probe-keys.js
// Reads all configured Gemini API keys the same way fetch-announcements.js
// does, then prints a masked summary so you can verify the keys are loaded
// and in the expected priority order. Makes ZERO API calls — completely
// safe to run any number of times.
//
// Usage:
//   node probe-keys.js

const fs = require("fs");
const path = require("path");

// Same logic as fetch-announcements.js::getGeminiKeys() — duplicated here
// so this script stays self-contained and has no import side effects.
function getGeminiKeys() {
  const keys = [];
  const sources = [];

  if (process.env.GEMINI_API_KEY) {
    for (const part of process.env.GEMINI_API_KEY.split(",")) {
      const t = part.trim();
      if (t) {
        keys.push(t);
        sources.push("env:GEMINI_API_KEY");
      }
    }
  }
  const singleFile = path.join(__dirname, ".gemini-key");
  if (fs.existsSync(singleFile)) {
    const k = fs.readFileSync(singleFile, "utf-8").trim();
    if (k) {
      keys.push(k);
      sources.push(".gemini-key");
    }
  }
  const multiFile = path.join(__dirname, ".gemini-keys");
  if (fs.existsSync(multiFile)) {
    const lines = fs.readFileSync(multiFile, "utf-8").split(/\r?\n/);
    let idx = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      idx++;
      keys.push(line);
      sources.push(`.gemini-keys:line${idx}`);
    }
  }

  // De-dupe — preserve first occurrence order. (Matches the production
  // dedup in getGeminiKeys.)
  const seen = new Set();
  const dedupedKeys = [];
  const dedupedSources = [];
  for (let i = 0; i < keys.length; i++) {
    if (seen.has(keys[i])) continue;
    seen.add(keys[i]);
    dedupedKeys.push(keys[i]);
    dedupedSources.push(sources[i]);
  }
  return { keys: dedupedKeys, sources: dedupedSources, rawCount: keys.length };
}

function maskKey(k) {
  if (!k) return "(empty)";
  if (k.length < 16) return k.substring(0, 4) + "...(short, looks wrong)";
  return k.substring(0, 10) + "..." + k.substring(k.length - 4) + ` (len ${k.length})`;
}

function looksLikeGeminiKey(k) {
  return /^AIza[A-Za-z0-9_-]{30,}$/.test(k);
}

function main() {
  console.log("\nGemini API key probe");
  console.log("=".repeat(60));

  const { keys, sources, rawCount } = getGeminiKeys();
  if (keys.length === 0) {
    console.log("No Gemini keys configured. To add one:");
    console.log(`  echo AIza...your_key_here > "${path.join(__dirname, ".gemini-key")}"`);
    console.log("Or for multiple keys with auto-rotation:");
    console.log(`  Create ${path.join(__dirname, ".gemini-keys")} with one key per line.`);
    process.exit(1);
  }

  if (rawCount !== keys.length) {
    console.log(
      `Note: found ${rawCount} entries, ${keys.length} unique after de-dup ` +
        `(${rawCount - keys.length} duplicate(s) ignored).\n`
    );
  }

  console.log(`Loaded ${keys.length} key(s), tried in this order:\n`);
  let allValid = true;
  for (let i = 0; i < keys.length; i++) {
    const valid = looksLikeGeminiKey(keys[i]);
    const marker = valid ? "  OK " : " ??? ";
    if (!valid) allValid = false;
    console.log(
      `  ${i + 1}. [${marker}] ${maskKey(keys[i])}  ←  ${sources[i]}`
    );
  }

  console.log("");
  if (!allValid) {
    console.log("Warning: one or more keys do NOT match the expected Gemini format");
    console.log("         (should start with 'AIza' followed by ~35 letters/digits).");
    console.log("         A malformed key will return HTTP 400 instead of valid OCR.");
  } else {
    console.log("All keys have the expected AIza... format.");
  }
  console.log("\nRotation behaviour: starts with key #1. On a 429 (quota exhausted)");
  console.log("that doesn't recover after retries, the script rotates to key #2,");
  console.log("then #3, and so on. Throws only when ALL keys are exhausted.");
  console.log("\nNo API calls were made by this probe.");
}

main();
