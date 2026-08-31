# news-tools

Scrape ShareSansar announcements and post them as news to the NEPSE backend.

## Workflow

1. **Fetch** announcements from ShareSansar:
   ```
   node fetch-news.js
   ```
   - Asks how many to fetch (1–50, default 20)
   - Asks which language (1=English, 2=Nepali, 3=Mix — default 3)
   - Writes `news-to-post.json`

2. **Review** `news-to-post.json` manually. If Nepali/Mix, edit the
   `[TRANSLATE]` / `[नेपालीमा अनुवाद गर्नुहोस्]` placeholders with the real
   translation.

3. **Post** to the backend:
   ```
   node batch-post-news.js
   ```
   - Shows a preview table of every item
   - **Confirmation 1/2**: `yes` / `no`
   - **Confirmation 2/2**: type `POST <count>` exactly (e.g. `POST 20`)
   - Only then does it hit the API

## JWT auth chain (batch-post-news.js)

1. `BLOG_JWT` env var
2. `--jwt=...` CLI arg
3. `.jwt` file in this folder
4. Interactive prompt (auto-saves to `.jwt`)

## API

- Endpoint: `POST https://api.nepsetrading.com/news` (multipart)
- Fields: `english_title`, `nepali_title`, `author_name`, `english_summary`,
  `nepali_summary`, `english_content`, `nepali_content`, `tags[i]`, `file`
- **Image (`file`) is currently not uploaded.** The source image URL is
  stashed in `thumbnail_url` on each news object — wire this up later when
  you share the image upload endpoint.

## Flags

- `--dry-run` — show the flow without hitting the API
- `--file=path.json` — use a different input file
- `--delay=1000` — delay between posts (ms, default 800)
- `--jwt=...` — pass JWT on the CLI
