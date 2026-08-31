#!/usr/bin/env python3
"""
PaddleOCR worker for fetch-announcements.js.

Reads a notice image file, runs PaddleOCR with the Devanagari + English
recognition model, and writes the extracted text (UTF-8) to stdout.

    python paddle_ocr.py <image_path>

Exit codes:
    0  success — text on stdout
    2  argument / file error
    3  paddleocr package not installed
    4  PaddleOCR init failed (no Devanagari-capable model found)
    5  OCR inference failed
"""

import contextlib
import io
import os
import sys

# Bypass PaddleX's outbound connectivity probe to the model-host registry.
# Set BEFORE importing paddleocr so the package picks it up at init.
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

# Disable PaddlePaddle 3.x's OneDNN (MKLDNN) backend. PP-OCRv3 model files
# trip a "ConvertPirAttribute2RuntimeAttribute not support" error under
# PaddlePaddle 3.3 when OneDNN tries to execute their op graph. The
# fallback CPU executor handles them correctly.
os.environ.setdefault("FLAGS_use_mkldnn", "False")
# Also disable the PIR-based executor path that conflicts with older OCR
# models. Falls back to the legacy executor which is fully compatible.
os.environ.setdefault("FLAGS_enable_pir_in_executor", "False")


def fail(msg: str, code: int) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


def write_utf8(text: str) -> None:
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")


def extract_v3_texts(result_obj) -> list:
    if hasattr(result_obj, "json"):
        data = result_obj.json
    elif isinstance(result_obj, dict):
        data = result_obj
    else:
        return []
    if not isinstance(data, dict):
        return []
    inner = data.get("res") if isinstance(data.get("res"), dict) else data
    for key in ("rec_texts", "texts", "rec_text"):
        val = inner.get(key)
        if isinstance(val, list):
            return [t for t in val if t]
    return []


def extract_v2_texts(result) -> list:
    """Extract recognized text from PaddleOCR v2.x output, grouping detected
    text boxes into logical lines using bounding-box y-coordinates.

    PaddleOCR's detector returns per-word boxes. Emitting one box per output
    line gives a wall of single-word paragraphs in the downstream renderer.
    To reconstruct readable lines we:
      1. Compute each box's y-center and x-center from its 4 corner points.
      2. Sort by y-center top-to-bottom.
      3. Group consecutive boxes whose y-centers are within ~60% of the
         average line height — that's the same logical line.
      4. Within each line, sort boxes left-to-right by x-center.
      5. Join the per-line words with single spaces.
    """
    output_lines = []
    if not result or not isinstance(result, list):
        return output_lines

    for page in result:
        if not page:
            continue

        boxes = []
        for entry in page:
            if not entry or len(entry) < 2:
                continue
            bbox = entry[0]
            text_tuple = entry[1]
            if not (
                isinstance(text_tuple, (list, tuple))
                and len(text_tuple) >= 1
                and text_tuple[0]
            ):
                continue
            text = text_tuple[0]

            # bbox is typically [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] (4 corners)
            if isinstance(bbox, list) and len(bbox) >= 4:
                try:
                    ys = [float(pt[1]) for pt in bbox]
                    xs = [float(pt[0]) for pt in bbox]
                    y_center = sum(ys) / len(ys)
                    x_center = sum(xs) / len(xs)
                    height = max(ys) - min(ys)
                except (TypeError, IndexError, ValueError):
                    y_center = x_center = 0.0
                    height = 20.0
            else:
                y_center = x_center = 0.0
                height = 20.0

            boxes.append({"y": y_center, "x": x_center, "h": height, "t": text})

        if not boxes:
            continue

        boxes.sort(key=lambda b: b["y"])

        avg_h = sum(b["h"] for b in boxes) / len(boxes)
        tolerance = max(avg_h * 0.6, 8.0)

        line_buf = [boxes[0]]
        for b in boxes[1:]:
            if abs(b["y"] - line_buf[0]["y"]) <= tolerance:
                line_buf.append(b)
            else:
                line_buf.sort(key=lambda x: x["x"])
                output_lines.append(" ".join(x["t"] for x in line_buf))
                line_buf = [b]
        if line_buf:
            line_buf.sort(key=lambda x: x["x"])
            output_lines.append(" ".join(x["t"] for x in line_buf))

    return output_lines


# Devanagari-using language codes. All cover the same script.
LANG_CODES = ["devanagari", "hi", "ne", "mr", "sa"]
OCR_VERSIONS = ["PP-OCRv3", "PP-OCRv4", "PP-OCRv5", None]


def try_init_v3(PaddleOCR, lang: str, version: str | None):
    """Build a PaddleOCR v3.x instance with auxiliary models disabled.

    Auxiliary models we explicitly skip (PaddleOCR 3.x downloads them by
    default on first use, which can fail behind firewalls and slows things
    down even when it succeeds):
        - use_doc_orientation_classify=False  → no PP-LCNet_x1_0_doc_ori
        - use_doc_unwarping=False             → no doc unwarper
        - use_textline_orientation=False      → no textline orientation
    These help when scans are sideways or warped; ShareSansar images are
    always upright, so we save time and avoid the download issue.
    """
    kwargs = {
        "lang": lang,
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    if version:
        kwargs["ocr_version"] = version
    return PaddleOCR(**kwargs)


def main() -> None:
    if len(sys.argv) != 2:
        fail("Usage: python paddle_ocr.py <image_path>", 2)

    image_path = sys.argv[1]
    if not os.path.isfile(image_path):
        fail(f"Image file not found: {image_path}", 2)

    try:
        from paddleocr import PaddleOCR
    except ImportError:
        fail(
            "PaddleOCR is not installed. Run:\n"
            "    pip install paddlepaddle paddleocr",
            3,
        )

    ocr = None
    use_v3 = False
    chosen_lang = None
    chosen_version = None
    attempted = []

    # ── Try v2.x signature first ──
    try:
        ocr = PaddleOCR(use_angle_cls=True, lang="devanagari", show_log=False)
        chosen_lang = "devanagari (v2 API)"
    except (TypeError, ValueError):
        pass
    except Exception as e:
        attempted.append(f"v2 devanagari: {str(e)[:200]}")

    # ── v3.x brute force ──
    if ocr is None:
        for version in OCR_VERSIONS:
            if ocr is not None:
                break
            for lang in LANG_CODES:
                try:
                    ocr = try_init_v3(PaddleOCR, lang, version)
                    use_v3 = True
                    chosen_lang = lang
                    chosen_version = version
                    break
                except TypeError:
                    # Constructor doesn't accept use_doc_* kwargs in older
                    # v3 builds — retry without them.
                    try:
                        kwargs = {"lang": lang}
                        if version:
                            kwargs["ocr_version"] = version
                        ocr = PaddleOCR(**kwargs)
                        use_v3 = True
                        chosen_lang = lang
                        chosen_version = version
                        break
                    except Exception as e2:
                        attempted.append(
                            f"v3 lang={lang} ocr_version={version or 'default'} (minimal kwargs): {str(e2)[:200]}"
                        )
                        continue
                except Exception as e:
                    attempted.append(
                        f"v3 lang={lang} ocr_version={version or 'default'}: {str(e)[:200]}"
                    )
                    continue

    if ocr is None:
        seen = set()
        unique = []
        for a in attempted:
            key = a.split(":", 1)[1].strip() if ":" in a else a
            if key not in seen:
                seen.add(key)
                unique.append(a)
        joined = "\n  - ".join(unique[:8])
        fail(
            "PaddleOCR init failed — no working (lang, ocr_version) combo found.\n"
            f"Tried {len(attempted)} combinations. Unique errors:\n  - {joined}\n\n"
            "Most reliable fix: downgrade to PaddleOCR 2.7:\n"
            "  pip uninstall -y paddleocr paddlex paddlepaddle\n"
            "  pip install paddlepaddle==2.6.0 paddleocr==2.7.0.3",
            4,
        )

    # Breadcrumb so the calling tool sees which combo won
    print(
        f"[paddle_ocr] using lang={chosen_lang} ocr_version={chosen_version} use_v3={use_v3}",
        file=sys.stderr,
        flush=True,
    )

    # ── Run OCR ──
    # PaddleOCR's downloader uses plain print() to announce model downloads.
    # Capturing PaddleOCR's stdout into an in-memory buffer keeps those
    # messages out of our text output (which is what the Node parent reads
    # from our stdout). The captured text goes to stderr as a breadcrumb.
    paddle_stdout = io.StringIO()
    try:
        with contextlib.redirect_stdout(paddle_stdout):
            if use_v3:
                results = ocr.predict(image_path)
                lines = []
                for r in results or []:
                    lines.extend(extract_v3_texts(r))
            else:
                result = ocr.ocr(image_path, cls=True)
                lines = extract_v2_texts(result)
    except Exception as e:
        # Surface the captured stdout (model download progress, etc.) to
        # stderr so failures are diagnosable.
        captured = paddle_stdout.getvalue().strip()
        if captured:
            print(f"[paddle_ocr stdout-during-error]\n{captured}", file=sys.stderr, flush=True)
        print(f"[paddle_ocr ERROR] OCR inference failed: {e}", file=sys.stderr, flush=True)
        fail(f"OCR inference failed: {e}", 5)

    # Emit any non-empty captured stdout as a stderr breadcrumb (model
    # download lines, etc.) — useful debug info, not OCR output.
    captured = paddle_stdout.getvalue().strip()
    if captured:
        print(f"[paddle_ocr noise]\n{captured}", file=sys.stderr, flush=True)

    write_utf8("\n".join(lines))


if __name__ == "__main__":
    main()
