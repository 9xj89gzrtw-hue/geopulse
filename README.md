# geopulse

[![CLI](https://img.shields.io/badge/cli-zero--dependencies-2ea44f)](https://github.com/9xj89gzrtw-hue/geopulse)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Live audit](https://img.shields.io/badge/live-geopulse--rouge.vercel.app-orange)](https://geopulse-rouge.vercel.app)
[![GitHub](https://img.shields.io/badge/github-9xj89gzrtw--hue-181717)](https://github.com/9xj89gzrtw-hue/geopulse)

**Terminal auditor for AI-Search (GEO) readiness.**
`geopulse` is a single-file, zero-dependency Node.js CLI that tells you whether
ChatGPT / Perplexity / Claude / Google AI Overviews can actually read, quote and
attribute your website — and what exactly to fix.

> Live web version with the full generated Fix Pack:
> **[https://geopulse-rouge.vercel.app](https://geopulse-rouge.vercel.app)**

---

## Install & run

```bash
# straight from the repo — no install, no dependencies
node bin/geopulse.mjs stripe.com

# or link it globally
npm link && geopulse stripe.com
```

Requires **Node.js >= 20** (uses the built-in `fetch`). There are **zero runtime
dependencies** — nothing to audit, no supply chain, no telemetry.

```bash
node bin/geopulse.mjs stripe.com
node bin/geopulse.mjs https://example.com/blog --json
node bin/geopulse.mjs example.com --fail-under=70   # CI gate
node bin/geopulse.mjs example.com --timeout=15000
```

| Flag | Meaning |
|---|---|
| `--json` | machine-readable audit result |
| `--timeout=<ms>` | per-request timeout (default `6000`) |
| `--fail-under=<n>` | exit code `1` when the score is below `<n>` |
| `--no-fix-pack` | hide the Fix Pack link in the text report |
| `-h`, `--help` / `-v`, `--version` | usage / version |

---

## Example output

```text
GeoPulse 1.0.0 — AI-Search (GEO) readiness audit
Target: https://example.com/

  AI crawlers allowed in robots.txt         18/18  PASS
  llms.txt present and structured           12/14  WARN
  llms-full.txt present for full context      6/8  WARN
  JSON-LD structured data for AI answers    14/14  PASS
  Canonical + Open Graph metadata           12/12  PASS
  Heading hierarchy and content density     12/12  PASS
  sitemap.xml with lastmod freshness        10/10  PASS
  Fast response and indexable headers       12/12  PASS
  ---------------------------------------------------
  TOTAL                                    96/100  GRADE A

Top fixes:
  1. Complete /llms.txt: add a blockquote summary, "## Section" blocks and markdown links to your key pages.
  2. Publish /llms-full.txt — a plain-text, heading-structured version of the key pages so answer engines can quote full context.

Full Fix Pack (robots.txt + llms.txt + llms-full.txt + JSON-LD + Cloudflare rules):
  https://geopulse-rouge.vercel.app
```

---

## What is checked (8 checks, 100 points)

| # | Check | Points | What it means |
|---|---|---|---|
| 1 | AI crawlers allowed in `robots.txt` | 18 | Are `OAI-SearchBot`, `PerplexityBot`, `Claude-SearchBot`, `GPTBot`, `Google-Extended` allowed — and declared explicitly? |
| 2 | `llms.txt` present and structured | 14 | `/llms.txt` exists with a `# Title`, a blockquote summary, `## Section` blocks and markdown links |
| 3 | `llms-full.txt` present | 8 | Full-context plain-text version for answer engines that quote long passages |
| 4 | JSON-LD structured data | 14 | `Organization`/`WebSite` + `Product`/`SoftwareApplication` + `FAQPage`/`Article` schema, all valid JSON |
| 5 | Canonical + Open Graph | 12 | `rel=canonical`, `og:title`, `og:description`, meta description |
| 6 | Heading hierarchy & text density | 12 | Exactly one `<h1>`, real `<h2>`/`<h3>` structure, healthy markup-to-text ratio |
| 7 | `sitemap.xml` with freshness | 10 | Sitemap exists, contains `<loc>` entries and `<lastmod>` timestamps |
| 8 | Speed & indexability | 12 | TTFB below 800 ms and no `X-Robots-Tag: noindex` / `noai` blocking header |

**Grades:** `A` ≥ 85 · `B` ≥ 70 · `C` ≥ 55 · `D` ≥ 40 · `E` < 40.

The CLI only *reports*. The hosted version at
**[https://geopulse-rouge.vercel.app](https://geopulse-rouge.vercel.app)**
generates the ready-to-paste Fix Pack: a patched `robots.txt`, a written
`llms.txt` / `llms-full.txt`, a `JSON-LD` block and the Cloudflare rules.

---

## Cloudflare `Content-Signal` (from 15.09.2026)

Cloudflare's **Content-Signal** directive (rolled out for the AI-content
policy line that became effective **15.09.2026**) lets a site state, in a
single HTTP response header, how AI crawlers may use the page:

```http
Content-Signal: search=yes, ai-train=no
```

* `search=yes` — AI search engines (ChatGPT Search, Perplexity, AI Overviews)
  may quote the page.
* `search=no` — the page is **excluded from AI search answers**. This is the
  single most expensive mistake a site can make, because no amount of
  `llms.txt` will compensate for it.
* `ai-train=yes|no` — controls whether the page may be used for model training
  independently of AI search.

`geopulse` reads the `Content-Signal` header from both `robots.txt` and the
page itself and applies an automatic **−6 point penalty** when
`search=no` is detected. If you did not set the header yourself, check your
Cloudflare zone settings — a leftover `search=no` from a "block AI scrapers"
experiment silently removes you from every AI answer.

---

## Why this exists

Answer engines do not read pages, they read *structured, explicitly permitted
context*. The three things that decide whether your content can be quoted:

1. **Permission** — `robots.txt` groups for the 5 major AI bots, plus a
   Cloudflare `Content-Signal` that does not say `search=no`.
2. **Context files** — `llms.txt` / `llms-full.txt` (the
   [llmstxt.org](https://llmstxt.org/) convention) that tell a model what the
   site is about and which pages matter.
3. **Extractability** — valid JSON-LD, canonical URLs, Open Graph tags and a
   clean heading hierarchy, so an answer engine can quote you with an
   attribution.

`geopulse` scores all three in one command and hands you the diff.

---

## Library usage

```js
import { auditSite, formatReport } from './bin/geopulse.mjs';

const result = await auditSite('example.com');
console.log(result.score, result.grade);   // 96 'A'
console.log(formatReport(result));
```

Every function accepts an injectable `fetchImpl`, which is what the offline
test-suite uses.

---

## Security & privacy

* No telemetry, no analytics, no cookies, no third-party calls.
* The CLI only issues `GET` requests to the audited origin (`/` ,
  `/robots.txt`, `/llms.txt`, `/llms-full.txt`, `/sitemap.xml`).
* Every request is bounded: 6 s timeout, 512 KB response cap.

## License

[MIT](./LICENSE) © GeoPulse contributors.
