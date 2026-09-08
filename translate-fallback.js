// Text-only English fallback for notices too large to transcribe AND translate
// in a single Gemini response.
//
// The combined OCR call returns {content, content_en} as one JSON object, so
// both languages share one maxOutputTokens budget. Mutual-fund OFFER LETTERS
// blow straight through it: on 2026-09-07 two of them transcribed to 75,559 and
// 104,608 Nepali characters and the budget was exhausted before content_en
// began, giving "0 en chars [MAX_TOKENS]". Raising the ceiling alone cannot fix
// this — at those sizes the two languages together exceed any single response.
//
// So translate SEPARATELY, from the Nepali already extracted, in
// paragraph-aligned chunks. No image is sent, which also keeps this off the
// vision path that saturates first.
//
// Lives in its own module so fetch-announcements.js stays the pipeline and this
// stays independently testable. Key access is injected rather than imported,
// because the key rotation state belongs to the caller.

const TRANSLATE_CHUNK_CHARS = 12000;

// Split on blank lines, packing paragraphs up to `limit`. A single oversized
// paragraph falls back to line breaks — never a mid-word cut, so no number or
// word is torn in half across two translation requests.
function chunkForTranslation(text, limit = TRANSLATE_CHUNK_CHARS) {
  const paras = String(text == null ? "" : text).split(/\n{2,}/);
  const out = [];
  let buf = "";
  for (const para of paras) {
    if (para.length > limit) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      let rest = para;
      while (rest.length > limit) {
        let cut = rest.lastIndexOf("\n", limit);
        if (cut < limit * 0.5) cut = limit;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      if (rest.trim()) buf = rest;
      continue;
    }
    if (buf && buf.length + para.length + 2 > limit) {
      out.push(buf);
      buf = para;
    } else {
      buf = buf ? buf + "\n\n" + para : para;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

const PROMPT_HEAD = [
  "Translate the following Nepali stock-exchange notice into English.",
  "Preserve the line and paragraph structure EXACTLY: one output line per input",
  "line, tables kept as the same rows and columns, and every number copied",
  "verbatim. Convert Devanagari digits to Latin digits. Output ONLY the",
  "translation, with no preamble and no commentary.",
  "",
  "",
].join("\n");

async function translateChunkWithKey(chunk, model, key) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":generateContent?key=" +
    key;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT_HEAD + chunk }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 65535,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (res.status === 429) return { exhausted429: true };
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Gemini " + res.status + ": " + t.substring(0, 200));
  }
  const data = await res.json();
  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  return {
    exhausted429: false,
    text: parts.map((x) => x.text || "").join(""),
    finishReason: cand && cand.finishReason,
  };
}

// Returns "" on ANY failure and never throws — the caller decides what an empty
// translation means. Throwing here would discard a Nepali body that was already
// extracted successfully, which is the opposite of the point.
//
// `deps` = { getKey, rotateKey, log } so the caller keeps ownership of key
// rotation state.
async function translateNepaliToEnglish(nepali, indexLabel, model, deps) {
  const getKey = deps.getKey;
  const rotateKey = deps.rotateKey;
  const log = deps.log || ((s) => process.stdout.write(s));

  const chunks = chunkForTranslation(nepali);
  log(
    "      " +
      indexLabel +
      " English empty — translating " +
      nepali.length +
      " chars in " +
      chunks.length +
      " chunk(s)..."
  );
  const t0 = Date.now();
  const out = [];

  for (const chunk of chunks) {
    let settled = false;
    while (!settled) {
      const key = getKey();
      if (!key) {
        log(" FAILED (no API key)\n");
        return "";
      }
      let r;
      try {
        r = await translateChunkWithKey(chunk, model, key);
      } catch (e) {
        log(" FAILED (" + String(e.message).substring(0, 70) + ")\n");
        return "";
      }
      if (r.exhausted429) {
        if (!rotateKey()) {
          log(" FAILED (all keys exhausted)\n");
          return "";
        }
        continue; // retry this same chunk with the next key
      }
      if (!r.text) {
        log(" FAILED (empty chunk, finishReason=" + r.finishReason + ")\n");
        return "";
      }
      out.push(r.text);
      settled = true;
    }
  }

  const joined = out.join("\n\n");
  log(" " + ((Date.now() - t0) / 1000).toFixed(1) + "s, " + joined.length + " en chars\n");
  return joined;
}

module.exports = {
  chunkForTranslation,
  translateNepaliToEnglish,
  TRANSLATE_CHUNK_CHARS,
};
