#!/usr/bin/env node

/* ================================================================== *
 * GeoPulse CLI — zero-dependency AI-Search (GEO) readiness auditor
 * ================================================================== *
 * Standalone, self-contained terminal auditor. No npm dependencies —
 * Node.js >= 20 built-ins only (`fetch`, `AbortController`, `TextDecoder`,
 * `TextEncoder`, `URL`).
 *
 * Usage:
 *   node bin/geopulse.mjs stripe.com
 *   node bin/geopulse.mjs https://example.com/blog --json
 *
 * What it checks (8 weighted checks, 100 points total):
 *   1. AI crawlers allowed in robots.txt      (18 pts)
 *   2. llms.txt present and structured        (14 pts)
 *   3. llms-full.txt present                  ( 8 pts)
 *   4. JSON-LD structured data                (14 pts)
 *   5. Canonical + Open Graph metadata        (12 pts)
 *   6. Heading hierarchy and content density  (12 pts)
 *   7. sitemap.xml with lastmod freshness     (10 pts)
 *   8. Fast response and indexable headers    (12 pts)
 *
 * Every network call is bounded (6 s timeout, 512 KB body cap) and the
 * scanner never throws — failures are reported through the result object.
 * ================================================================== */

import { pathToFileURL } from 'node:url';

export const CLI_VERSION = '1.0.0';

export const USER_AGENT = 'GeoPulseBot/1.0 (+https://geopulse-rouge.vercel.app)';
export const REQUEST_TIMEOUT_MS = 6000;
export const MAX_BODY_BYTES = 512 * 1024;

/** Where the user gets the full Fix Pack (robots.txt, llms.txt, JSON-LD, ...). */
export const FIX_PACK_URL = 'https://geopulse-rouge.vercel.app';

/** AI crawlers / training agents we look for in robots.txt. */
export const AI_BOT_USER_AGENTS = Object.freeze([
  'OAI-SearchBot',
  'PerplexityBot',
  'Claude-SearchBot',
  'GPTBot',
  'Google-Extended',
]);

const SCHEMA_ORG_TYPES = Object.freeze(['Organization', 'WebSite']);
const SCHEMA_PRODUCT_TYPES = Object.freeze([
  'Product',
  'SoftwareApplication',
  'Service',
  'WebApplication',
  'MobileApplication',
]);
const SCHEMA_CONTENT_TYPES = Object.freeze([
  'FAQPage',
  'HowTo',
  'Article',
  'TechArticle',
  'Question',
  'QAPage',
]);

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function byteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

const HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  middot: '·',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** Minimal HTML entity decoder (named + numeric). */
export function decodeEntities(input) {
  if (input === null || input === undefined) return '';
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, ent) => {
    if (ent[0] === '#') {
      const isHex = ent[1] === 'x' || ent[1] === 'X';
      const code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const key = ent.toLowerCase();
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, key) ? HTML_ENTITIES[key] : match;
  });
}

/** Lowercase, protocol/path-free hostname. */
export function normalizeDomain(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  let host = raw;
  try {
    const withProto = /^https?:\/\//i.test(host) ? host : `https://${host}`;
    host = new URL(withProto).hostname;
  } catch {
    host = host.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0];
  }
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Normalizes a user supplied target into the exact set of URLs we probe.
 * The page URL keeps the original path; auxiliary files resolve against
 * the origin.
 */
export function normalizeTargetUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Invalid target URL: empty value');
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProto);
  } catch {
    throw new Error(`Invalid target URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid target URL protocol: ${parsed.protocol}`);
  }
  parsed.hash = '';
  const origin = `${parsed.protocol}//${parsed.host}`;
  return {
    url: parsed.toString(),
    domain: parsed.hostname.toLowerCase(),
    origin,
    robotsUrl: `${origin}/robots.txt`,
    llmsUrl: `${origin}/llms.txt`,
    llmsFullUrl: `${origin}/llms-full.txt`,
    sitemapUrl: `${origin}/sitemap.xml`,
  };
}

/* ------------------------------------------------------------------ *
 * robots.txt parsing
 * ------------------------------------------------------------------ */

/**
 * Parses robots.txt into groups. A group = consecutive `User-agent`
 * lines sharing the following Allow/Disallow rules.
 */
export function parseRobotsTxt(text) {
  const raw = String(text ?? '');
  const groups = [];
  const sitemaps = [];
  let current = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      if (!current) {
        current = { agents: ['*'], rules: [] };
        groups.push(current);
      }
      current.rules.push({ type: field, path: value });
    }
  }

  return { raw, groups, sitemaps, isEmpty: raw.trim().length === 0 };
}

/** Converts a robots.txt path pattern into a regular expression. */
export function patternToRegExp(pattern) {
  let out = '';
  for (const ch of String(pattern)) {
    if (ch === '*') out += '.*';
    else if (ch === '$') out += '$';
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}`);
}

/** Longest-match rule wins; Allow beats Disallow on equal length. */
export function isPathAllowed(rules, path = '/') {
  let best = null;
  for (const rule of rules || []) {
    if (rule.type === 'allow' && rule.path === '') continue;
    if (!rule.path) continue;
    const re = patternToRegExp(rule.path);
    if (!re.test(path)) continue;
    const len = rule.path.replace(/\*/g, '').length;
    if (!best || len > best.len || (len === best.len && rule.type === 'allow')) {
      best = { len, type: rule.type };
    }
  }
  if (!best) return true;
  return best.type === 'allow';
}

/** Resolves the effective access of a named bot against parsed robots.txt. */
export function resolveBotAccess(robots, botName) {
  const bot = String(botName || '').toLowerCase();
  const groups = (robots && robots.groups) || [];
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && a === bot));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const chosen = specific.length > 0 ? specific : wildcard;

  if (chosen.length === 0) {
    return { bot: botName, declared: false, allowed: true, matchedGroup: 'none', rules: [] };
  }

  const rules = chosen.flatMap((g) => g.rules);
  return {
    bot: botName,
    declared: specific.length > 0,
    allowed: isPathAllowed(rules, '/'),
    matchedGroup: specific.length > 0 ? 'specific' : 'wildcard',
    rules,
  };
}

/* ------------------------------------------------------------------ *
 * Cloudflare Content-Signal parsing
 * ------------------------------------------------------------------ */

/**
 * Parses a Cloudflare `Content-Signal` header value, e.g.
 * `search=yes, ai-train=no`.
 */
export function parseContentSignal(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value);
  const out = { raw, search: null, aiTrain: null };
  for (const part of raw.split(',')) {
    const chunk = part.trim();
    if (!chunk) continue;
    const idx = chunk.indexOf('=');
    if (idx === -1) continue;
    const key = chunk.slice(0, idx).trim().toLowerCase();
    const val = chunk.slice(idx + 1).trim().toLowerCase();
    if (key === 'search') out.search = val;
    else if (key === 'ai-train' || key === 'aitrain') out.aiTrain = val;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * llms.txt parsing
 * ------------------------------------------------------------------ */

/**
 * Parses an llms.txt document (https://llmstxt.org/ convention):
 * `# Title`, an optional `> summary` blockquote, `## Section` blocks and
 * `- [Title](url)` link lists.
 */
export function parseLlmsTxt(text) {
  const raw = String(text ?? '');
  let docTitle = '';
  let blockquote = '';
  const headings = [];
  const links = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1) {
      if (!docTitle) docTitle = decodeEntities(h1[1].trim());
      continue;
    }
    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      headings.push({ level: 2, text: decodeEntities(h2[1].trim()) });
      continue;
    }
    const h3 = trimmed.match(/^###\s+(.+)$/);
    if (h3) {
      headings.push({ level: 3, text: decodeEntities(h3[1].trim()) });
      continue;
    }
    const link = trimmed.match(/^[-*+]\s+\[([^\]]*)\]\(([^)\s]+)\)/);
    if (link) {
      links.push({ title: decodeEntities(link[1].trim()), url: link[2].trim() });
      continue;
    }
    if (!blockquote && trimmed.startsWith('>')) {
      blockquote = decodeEntities(trimmed.replace(/^>\s?/, '').trim());
    }
  }

  const bytes = byteLength(raw);
  return {
    raw,
    bytes,
    title: docTitle,
    hasTitle: Boolean(docTitle),
    blockquote,
    headings,
    headingCount: headings.length,
    hasHeadings: headings.length > 0,
    sectionCount: headings.filter((h) => h.level === 2).length,
    links,
    linkCount: links.length,
    visibleLength: raw.replace(/\s+/g, ' ').trim().length,
    isEmpty: raw.trim().length === 0,
  };
}

/* ------------------------------------------------------------------ *
 * HTML parsing
 * ------------------------------------------------------------------ */

/** Parses attributes out of a raw `<meta ...>` / `<link ...>` tag. */
export function parseTagAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(String(tag)))) {
    const name = m[1].toLowerCase();
    if (name === 'meta' || name === 'link') continue;
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** Extracts visible text (scripts, styles, comments removed). */
export function extractVisibleText(html) {
  const src = String(html ?? '');
  const stripped = src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ');
  return decodeEntities(stripped.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Extracts and parses every `<script type="application/ld+json">` block. */
export function parseJsonLd(html) {
  const src = String(html ?? '');
  const blocks = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      blocks.push({ ok: true, raw, data: JSON.parse(raw), error: null });
    } catch (err) {
      blocks.push({ ok: false, raw, data: null, error: err?.message || 'Invalid JSON' });
    }
  }
  return blocks;
}

/** Collects every `@type` value out of a parsed JSON-LD tree. */
export function collectJsonLdTypes(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdTypes(item, out);
    return out;
  }
  const type = node['@type'];
  if (typeof type === 'string') out.add(type);
  else if (Array.isArray(type)) {
    for (const item of type) if (typeof item === 'string') out.add(item);
  }
  if (node['@graph']) collectJsonLdTypes(node['@graph'], out);
  return out;
}

/** Head/body extraction for a HTML document. */
export function parseHtmlDocument(html) {
  const src = String(html ?? '');

  const titleMatch = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : '';

  const metas = [];
  const metaRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(src))) metas.push(parseTagAttrs(m[0]));

  const links = [];
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(src))) links.push(parseTagAttrs(m[0]));

  const findMeta = (pred) => {
    for (const meta of metas) if (pred(meta)) return meta;
    return null;
  };

  const canonicalTag = links.find((l) =>
    String(l.rel || '').toLowerCase().split(/\s+/).includes('canonical'),
  );
  const canonical = canonicalTag ? String(canonicalTag.href || '').trim() : '';

  const ogTitleMeta = findMeta((t) => String(t.property || '').toLowerCase() === 'og:title');
  const ogDescriptionMeta = findMeta(
    (t) => String(t.property || '').toLowerCase() === 'og:description',
  );
  const ogUrlMeta = findMeta((t) => String(t.property || '').toLowerCase() === 'og:url');
  const ogImageMeta = findMeta((t) => String(t.property || '').toLowerCase() === 'og:image');
  const descriptionMeta = findMeta((t) => String(t.name || '').toLowerCase() === 'description');
  const robotsMeta = findMeta((t) => String(t.name || '').toLowerCase() === 'robots');

  const headings = { h1: [], h2: [], h3: [] };
  const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  while ((m = headingRe.exec(src))) {
    const level = Number(m[1]);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (level <= 3) headings[`h${level}`].push(text);
  }

  const jsonLdBlocks = parseJsonLd(src);
  const jsonLdTypes = new Set();
  for (const block of jsonLdBlocks) {
    if (block.ok) collectJsonLdTypes(block.data, jsonLdTypes);
  }

  const visibleText = extractVisibleText(src);
  const textRatio = src.length > 0 ? Math.round((visibleText.length / src.length) * 10000) / 10000 : 0;

  return {
    raw: src,
    length: src.length,
    title,
    description: descriptionMeta ? String(descriptionMeta.content || '').trim() : '',
    canonical,
    ogTitle: ogTitleMeta ? String(ogTitleMeta.content || '').trim() : '',
    ogDescription: ogDescriptionMeta ? String(ogDescriptionMeta.content || '').trim() : '',
    ogUrl: ogUrlMeta ? String(ogUrlMeta.content || '').trim() : '',
    ogImage: ogImageMeta ? String(ogImageMeta.content || '').trim() : '',
    metaRobots: robotsMeta ? String(robotsMeta.content || '').trim() : '',
    headings,
    h1Count: headings.h1.length,
    h2Count: headings.h2.length,
    h3Count: headings.h3.length,
    jsonLdBlocks,
    jsonLdTypes: [...jsonLdTypes],
    visibleText,
    textRatio,
  };
}

/* ------------------------------------------------------------------ *
 * sitemap.xml parsing
 * ------------------------------------------------------------------ */

export function parseSitemapXml(xml) {
  const raw = String(xml ?? '');
  const locs = raw.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi) || [];
  const lastmods = raw.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/gi) || [];
  return {
    raw,
    isUrlset: /<urlset[\s>]/i.test(raw),
    isSitemapIndex: /<sitemapindex[\s>]/i.test(raw),
    urlCount: locs.length,
    lastmodCount: lastmods.length,
    hasLastmod: lastmods.length > 0,
    isEmpty: raw.trim().length === 0,
  };
}

/* ------------------------------------------------------------------ *
 * Bounded HTTP layer
 * ------------------------------------------------------------------ */

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

function normalizeError(err) {
  if (!err) return 'Unknown error';
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
  return err.message || String(err);
}

/** Reads a response body, stopping at `maxBytes` (512 KB cap). */
export async function readBodyLimited(response, maxBytes = MAX_BODY_BYTES) {
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;
  let truncated = false;

  const body = response && response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        let chunk = value;
        if (bytes + chunk.length > maxBytes) {
          chunk = chunk.slice(0, Math.max(0, maxBytes - bytes));
          truncated = true;
        }
        bytes += chunk.length;
        text += decoder.decode(chunk, { stream: true });
        if (truncated) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    text += decoder.decode();
    return { text, bytes, truncated };
  }

  // Fallback path for lightweight/mock responses without a stream body.
  let raw = '';
  if (response && typeof response.text === 'function') {
    raw = await response.text();
  } else if (response && typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer();
    raw = decoder.decode(new Uint8Array(buffer));
  }
  const encoded = new TextEncoder().encode(raw);
  bytes = encoded.length;
  truncated = bytes > maxBytes;
  if (truncated) {
    const sliced = encoded.slice(0, maxBytes);
    return { text: decoder.decode(sliced), bytes: sliced.length, truncated };
  }
  return { text: raw, bytes, truncated };
}

/**
 * Single bounded HTTP GET. Never throws — network failures are reported
 * through the result object.
 */
export async function fetchResource(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = nowMs();

  const result = {
    url,
    ok: false,
    status: 0,
    statusText: '',
    headers: {},
    body: '',
    bytes: 0,
    truncated: false,
    error: null,
    ttfbMs: null,
    elapsedMs: null,
  };

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    result.ttfbMs = Math.round(nowMs() - started);
    // Test seam: a mock fetch may advertise a synthetic TTFB.
    if (response && typeof response.ttfbMs === 'number') result.ttfbMs = response.ttfbMs;
    result.status = Number(response.status) || 0;
    result.statusText = response.statusText || '';
    result.ok = response.ok !== false && result.status >= 200 && result.status < 400;
    result.headers = headersToObject(response.headers);
    const body = await readBodyLimited(response, maxBytes);
    result.body = body.text;
    result.bytes = body.bytes;
    result.truncated = body.truncated;
  } catch (err) {
    result.error = normalizeError(err);
    result.ttfbMs = result.ttfbMs ?? Math.round(nowMs() - started);
  } finally {
    clearTimeout(timer);
    result.elapsedMs = Math.round(nowMs() - started);
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

function makeCheck({ id, label, points, maxPoints, detail }) {
  const score = Math.max(0, Math.min(maxPoints, Math.round(points)));
  const status = score >= maxPoints ? 'pass' : score > 0 ? 'warn' : 'fail';
  return { id, label, status, points: score, maxPoints, detail };
}

function checkAiCrawlerAccess(robots, robotsRes, page) {
  const maxPoints = 18;
  let points = 0;
  const notes = [];

  if (robotsRes.status === 200 && robotsRes.ok) {
    points += 4;
    notes.push('robots.txt reachable');
  } else if (robotsRes.status === 404 || robotsRes.status === 410) {
    notes.push('robots.txt missing (404) — crawlers fall back to default allow-all');
  } else {
    notes.push(`robots.txt unreachable (${robotsRes.error || `HTTP ${robotsRes.status}`})`);
  }

  const bots = AI_BOT_USER_AGENTS.map((bot) => resolveBotAccess(robots, bot));
  const allowed = bots.filter((b) => b.allowed);
  const blocked = bots.filter((b) => !b.allowed);
  points += Math.round((10 * allowed.length) / AI_BOT_USER_AGENTS.length);

  if (blocked.length === 0) notes.push('all 5 AI crawlers allowed');
  else notes.push(`blocked: ${blocked.map((b) => b.bot).join(', ')}`);

  // Explicit per-bot groups are worth more than a wildcard `User-agent: *`.
  const declared = bots.filter((b) => b.declared);
  if (declared.length === bots.length) {
    points += 4;
    notes.push('every AI crawler has its own User-agent group');
  } else {
    const undeclared = bots.filter((b) => !b.declared);
    notes.push(`not explicitly declared: ${undeclared.map((b) => b.bot).join(', ')}`);
  }

  const contentSignal =
    parseContentSignal(robotsRes.headers['content-signal']) ||
    parseContentSignal(page.headers['content-signal']);
  if (contentSignal && contentSignal.search === 'no') {
    points = Math.min(points, maxPoints - 6);
    notes.push(`Cloudflare Content-Signal search=no (${contentSignal.raw})`);
  } else if (contentSignal && contentSignal.search === 'yes') {
    notes.push(`Cloudflare Content-Signal ${contentSignal.raw}`);
  }

  return makeCheck({
    id: 'ai-crawler-access',
    label: 'AI crawlers allowed in robots.txt',
    points,
    maxPoints,
    detail: notes.join('; '),
  });
}

function checkLlmsTxt(res, llms) {
  const maxPoints = 14;
  let points = 0;
  const notes = [];

  if (res.ok && res.status === 200) {
    points += 5;
    notes.push('/llms.txt found');
  } else {
    notes.push(`/llms.txt missing (HTTP ${res.status || res.error || 'n/a'})`);
  }
  if (llms.hasTitle) {
    points += 3;
    notes.push(`H1 title "${llms.title}"`);
  } else {
    notes.push('no H1 title');
  }
  if (llms.sectionCount > 0) {
    points += 2;
    notes.push(`${llms.sectionCount} section(s)`);
  } else {
    notes.push('no ## sections');
  }
  if (llms.linkCount > 0) {
    points += 2;
    notes.push(`${llms.linkCount} link(s)`);
  } else {
    notes.push('no markdown links');
  }
  if (llms.bytes >= 500) {
    points += 2;
    notes.push(`${llms.bytes} bytes`);
  } else {
    notes.push(`only ${llms.bytes} bytes`);
  }

  return makeCheck({
    id: 'llms-txt',
    label: 'llms.txt present and structured',
    points,
    maxPoints,
    detail: notes.join('; '),
  });
}

function checkLlmsFullTxt(res, llms) {
  const maxPoints = 8;
  let points = 0;
  const notes = [];

  if (res.ok && res.status === 200) {
    points += 4;
    notes.push('/llms-full.txt found');
  } else {
    notes.push(`/llms-full.txt missing (HTTP ${res.status || res.error || 'n/a'})`);
  }
  if (llms.visibleLength >= 2000) {
    points += 2;
    notes.push(`${llms.visibleLength} chars of content`);
  } else if (llms.visibleLength > 0) {
    points += 1;
    notes.push(`only ${llms.visibleLength} chars`);
  }
  if (llms.hasHeadings) {
    points += 2;
    notes.push(`${llms.headingCount} heading(s)`);
  }

  return makeCheck({
    id: 'llms-full-txt',
    label: 'llms-full.txt present for full context',
    points,
    maxPoints,
    detail: notes.join('; '),
  });
}

function checkStructuredData(doc) {
  const maxPoints = 14;
  let points = 0;
  const notes = [];

  const blocks = doc.jsonLdBlocks || [];
  if (blocks.length > 0) {
    points += 4;
    notes.push(`${blocks.length} JSON-LD block(s)`);
  } else {
    notes.push('no application/ld+json block');
  }

  const broken = blocks.filter((b) => !b.ok);
  if (blocks.length > 0 && broken.length === 0) {
    points += 2;
    notes.push('all blocks parse as valid JSON');
  } else if (broken.length > 0) {
    notes.push(`${broken.length} invalid JSON-LD block(s)`);
  }

  const types = new Set(doc.jsonLdTypes || []);
  const has = (list) => list.some((t) => types.has(t));

  if (has(SCHEMA_ORG_TYPES)) {
    points += 3;
    notes.push(`entity schema: ${[...types].filter((t) => SCHEMA_ORG_TYPES.includes(t)).join(', ')}`);
  } else {
    notes.push('missing Organization/WebSite schema');
  }
  if (has(SCHEMA_PRODUCT_TYPES)) {
    points += 3;
    notes.push(
      `product schema: ${[...types].filter((t) => SCHEMA_PRODUCT_TYPES.includes(t)).join(', ')}`,
    );
  } else {
    notes.push('missing Product/SoftwareApplication schema');
  }
  if (has(SCHEMA_CONTENT_TYPES)) {
    points += 2;
    notes.push(
      `content schema: ${[...types].filter((t) => SCHEMA_CONTENT_TYPES.includes(t)).join(', ')}`,
    );
  } else {
    notes.push('missing FAQPage/Article schema');
  }

  return makeCheck({
    id: 'schema-jsonld',
    label: 'JSON-LD structured data for AI answers',
    points,
    maxPoints,
    detail: notes.join('; '),
  });
}

function checkMetaSocial(doc) {
  const maxPoints = 12;
  let points = 0;
  const notes = [];

  if (doc.canonical) {
    points += 4;
    notes.push(`canonical: ${doc.canonical}`);
  } else {
    notes.push('no rel=canonical');
  }
  if (doc.ogTitle) {
    points += 3;
    notes.push('og:title present');
  } else {
    notes.push('no og:title');
  }
  if (doc.ogDescription) {
    points += 3;
    notes.push('og:description present');
  } else {
    notes.push('no og:description');
  }
  if (doc.description) {
    points += 2;
    notes.push('meta description present');
  } else {
    notes.push('no meta description');
  }

  return makeCheck({
    id: 'meta-social',
    label: 'Canonical + Open Graph metadata',
    points,
    maxPoints,
    detail: notes.join('; '),
  });
}

function checkContentStructure(doc) {
  const maxPoints = 12;
  let points = 0;
  const notes = [];

  if (doc.h1Count === 1) {
    points += 4;
    notes.push(`one h1: "${doc.headings.h1[0]}"`);
  } else if (doc.h1Count === 0) {
    notes.push('no h1 heading');
  } else {
    points += 2;
    notes.push(`${doc.h1Count} h1 headings (expected 1)`);
  }

  if (doc.h2Count > 0) {
    points += 3;
    notes.push(`${doc.h2Count} h2 section(s)`);
  } else {
    notes.push('no h2 sections');
  }

  if (doc.h3Count > 0) {
    points += 1;
    notes.push(`${doc.h3Count} h3 subsection(s)`);
  }

  if (doc.textRatio >= 0.25) {
    points += 4;
    notes.push(`text density ${(doc.textRatio * 100).toFixed(1)}%`);
  } else if (doc.textRatio >= 0.1) {
    points += 2;
    notes.push(`text density ${(doc.textRatio * 100).toFixed(1)}% (low)`);
  } else {
    notes.push(`text density ${(doc.textRatio * 100).toFixed(1)}% (very low)`);
  }

  return makeCheck({
    id: 'content-structure',
    label: 'Heading hierarchy and content density',
    points,
    maxPoints,
    detail: notes.join('; '),
  });
}

function checkSitemap(res, sitemap) {
  const maxPoints = 10;
  let points = 0;
  const notes = [];

  if (res.ok && res.status === 200) {
    points += 4;
    notes.push('/sitemap.xml found');
  } else {
    notes.push(`/sitemap.xml missing (HTTP ${res.status || res.error || 'n/a'})`);
  }
  if (sitemap.urlCount > 0) {
    points += 3;
    notes.push(`${sitemap.urlCount} url(s)`);
  } else {
    notes.push('no <loc> entries');
  }
  if (sitemap.hasLastmod) {
    points += 3;
    notes.push(`${sitemap.lastmodCount} <lastmod> value(s)`);
  } else {
    notes.push('no <lastmod> timestamps');
  }

  return makeCheck({
    id: 'sitemap',
    label: 'sitemap.xml with lastmod freshness',
    points,
    maxPoints,
    detail: notes.join('; '),
  });
}

function checkPerformanceAndIndexing(page) {
  const maxPoints = 12;
  let points = 0;
  const notes = [];

  if (!page.ok) {
    notes.push(`target unreachable (${page.error || `HTTP ${page.status}`})`);
    return makeCheck({
      id: 'performance-indexing',
      label: 'Fast response and indexable headers',
      points: 0,
      maxPoints,
      detail: notes.join('; '),
    });
  }

  const ttfb = Number(page.ttfbMs) || 0;
  if (ttfb <= 800) {
    points += 4;
    notes.push(`TTFB ${ttfb} ms`);
  } else if (ttfb <= 2000) {
    points += 2;
    notes.push(`TTFB ${ttfb} ms (target < 800 ms)`);
  } else {
    notes.push(`TTFB ${ttfb} ms (target < 800 ms)`);
  }
  points += 2;
  notes.push('page reachable');

  const xRobotsTag = String(page.headers['x-robots-tag'] || '');
  const metaRobots = String(page.metaRobots || '');
  const blocking = `${xRobotsTag} ${metaRobots}`;
  if (/noindex|noai/i.test(blocking)) {
    notes.push(`blocking directive: ${(xRobotsTag || metaRobots).trim()}`);
  } else {
    points += 6;
    notes.push('no X-Robots-Tag noindex/noai');
  }

  return makeCheck({
    id: 'performance-indexing',
    label: 'Fast response and indexable headers',
    points,
    maxPoints,
    detail: notes.join('; '),
  });
}

/* ------------------------------------------------------------------ *
 * Top fixes
 * ------------------------------------------------------------------ */

const FIX_TEMPLATES = {
  'ai-crawler-access': (check) => {
    if (/blocked:/i.test(check.detail)) {
      return 'Allow AI crawlers in /robots.txt: OAI-SearchBot, PerplexityBot, Claude-SearchBot, GPTBot and Google-Extended are currently blocked (or not declared).';
    }
    if (/missing/i.test(check.detail)) {
      return 'Publish /robots.txt and explicitly allow OAI-SearchBot, PerplexityBot, Claude-SearchBot, GPTBot and Google-Extended.';
    }
    if (/Content-Signal/i.test(check.detail)) {
      return 'Fix the Cloudflare Content-Signal header — it currently tells AI search engines not to use the content.';
    }
    return 'Declare AI crawlers explicitly in /robots.txt instead of relying on the wildcard group.';
  },
  'llms-txt': (check) =>
    /missing/i.test(check.detail)
      ? 'Publish /llms.txt: a "# Title" header, a one-line blockquote summary, "## Section" blocks and "- [Title](url)" link lists.'
      : 'Complete /llms.txt: add a blockquote summary, "## Section" blocks and markdown links to your key pages.',
  'llms-full-txt': () =>
    'Publish /llms-full.txt — a plain-text, heading-structured version of the key pages so answer engines can quote full context.',
  'schema-jsonld': (check) =>
    /invalid/i.test(check.detail)
      ? 'Fix the invalid JSON-LD block and add Organization + Product/SoftwareApplication + FAQPage schema.'
      : 'Add JSON-LD structured data: Organization/WebSite, Product or SoftwareApplication, and FAQPage for AI answer extraction.',
  'meta-social': (check) => {
    const missing = [];
    if (/no rel=canonical/i.test(check.detail)) missing.push('rel=canonical');
    if (/no og:title/i.test(check.detail)) missing.push('og:title');
    if (/no og:description/i.test(check.detail)) missing.push('og:description');
    if (/no meta description/i.test(check.detail)) missing.push('meta description');
    return `Add the missing page metadata: ${missing.join(', ') || 'canonical + Open Graph tags'}.`;
  },
  'content-structure': (check) => {
    const parts = [];
    if (/no h1/i.test(check.detail)) parts.push('add exactly one <h1>');
    else if (/h1 headings/.test(check.detail)) parts.push('reduce multiple <h1> tags to one');
    if (/no h2/i.test(check.detail)) parts.push('add <h2> sections');
    if (/density/i.test(check.detail)) parts.push('increase visible text density (thin markup-to-text ratio)');
    return `Fix content structure: ${parts.join('; ') || 'use a clean h1 → h2 → h3 hierarchy'}.`;
  },
  sitemap: (check) =>
    /missing/i.test(check.detail)
      ? 'Publish /sitemap.xml listing the pages AI engines should index.'
      : 'Add <lastmod> timestamps to /sitemap.xml so AI crawlers can detect freshness.',
  'performance-indexing': (check) => {
    if (/noindex|noai/i.test(check.detail)) {
      return 'Remove the blocking X-Robots-Tag: noindex/noai header — AI engines cannot quote content they may not index.';
    }
    if (/unreachable/i.test(check.detail)) {
      return 'Make the target reachable for AI crawlers — the audit could not load the page.';
    }
    return 'Reduce TTFB below 800 ms — answer engines drop slow pages from AI results.';
  },
};

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

export function gradeFor(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}

/**
 * Full GEO / AI-Search readiness audit.
 * Performs 5 bounded HTTP GETs (page, robots.txt, llms.txt, llms-full.txt,
 * sitemap.xml) and evaluates 8 weighted checks (100 points total).
 */
export async function auditSite(url, options = {}) {
  const target = normalizeTargetUrl(url);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const [page, robotsRes, llmsRes, llmsFullRes, sitemapRes] = await Promise.all([
    fetchResource(target.url, { fetchImpl, timeoutMs }),
    fetchResource(target.robotsUrl, { fetchImpl, timeoutMs }),
    fetchResource(target.llmsUrl, { fetchImpl, timeoutMs }),
    fetchResource(target.llmsFullUrl, { fetchImpl, timeoutMs }),
    fetchResource(target.sitemapUrl, { fetchImpl, timeoutMs }),
  ]);

  const html = page.ok ? page.body : '';
  const doc = parseHtmlDocument(html);
  const robots = parseRobotsTxt(robotsRes.ok ? robotsRes.body : '');
  const llms = parseLlmsTxt(llmsRes.ok ? llmsRes.body : '');
  const llmsFull = parseLlmsTxt(llmsFullRes.ok ? llmsFullRes.body : '');
  const sitemap = parseSitemapXml(sitemapRes.ok ? sitemapRes.body : '');

  const checks = [
    checkAiCrawlerAccess(robots, robotsRes, page),
    checkLlmsTxt(llmsRes, llms),
    checkLlmsFullTxt(llmsFullRes, llmsFull),
    checkStructuredData(doc),
    checkMetaSocial(doc),
    checkContentStructure(doc),
    checkSitemap(sitemapRes, sitemap),
    checkPerformanceAndIndexing(page),
  ];

  const score = checks.reduce((sum, c) => sum + c.points, 0);
  const grade = gradeFor(score);
  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;

  const topFixes = checks
    .filter((c) => c.status !== 'pass')
    .sort((a, b) => (b.maxPoints - b.points) - (a.maxPoints - a.points))
    .slice(0, 5)
    .map((c) => {
      const template = FIX_TEMPLATES[c.id];
      return template ? template(c) : `Fix: ${c.label.toLowerCase()}.`;
    });

  const headline = topFixes[0] || 'All 8 AI-search readiness checks pass.';
  const summary =
    `Score ${score}/100 (grade ${grade}) — ${passed}/${checks.length} checks passed` +
    (failed ? `, ${failed} failed` : '') +
    `. ${headline}`;

  return {
    url: target.url,
    domain: target.domain,
    score,
    grade,
    ttfbMs: page.ttfbMs ?? 0,
    summary,
    checks,
    topFixes,
    fixPackUrl: FIX_PACK_URL,
    resources: {
      page: { url: target.url, status: page.status, ok: page.ok, error: page.error },
      robots: { url: target.robotsUrl, status: robotsRes.status, ok: robotsRes.ok },
      llms: { url: target.llmsUrl, status: llmsRes.status, ok: llmsRes.ok },
      llmsFull: { url: target.llmsFullUrl, status: llmsFullRes.status, ok: llmsFullRes.ok },
      sitemap: { url: target.sitemapUrl, status: sitemapRes.status, ok: sitemapRes.ok },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

const STATUS_MARK = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };

/** Renders the compact score table + Fix Pack link. */
export function formatReport(result, options = {}) {
  const showFixPack = options.showFixPack !== false;
  const fixPackUrl = options.fixPackUrl || result.fixPackUrl || FIX_PACK_URL;
  const labelWidth = Math.max(
    12,
    ...result.checks.map((c) => c.label.length),
  );
  const lines = [];

  lines.push(`GeoPulse ${CLI_VERSION} — AI-Search (GEO) readiness audit`);
  lines.push(`Target: ${result.url}`);
  lines.push('');

  for (const check of result.checks) {
    const score = `${check.points}/${check.maxPoints}`;
    lines.push(
      `  ${check.label.padEnd(labelWidth)}  ${score.padStart(7)}  ${STATUS_MARK[check.status] || check.status}`,
    );
  }

  lines.push(`  ${'-'.repeat(labelWidth + 13)}`);
  lines.push(
    `  ${'TOTAL'.padEnd(labelWidth)}  ${`${result.score}/100`.padStart(7)}  GRADE ${result.grade}`,
  );
  lines.push('');

  if (result.topFixes.length > 0) {
    lines.push('Top fixes:');
    result.topFixes.forEach((fix, i) => lines.push(`  ${i + 1}. ${fix}`));
  } else {
    lines.push('Top fixes: none — every AI-search readiness check passes.');
  }
  lines.push('');
  if (showFixPack) {
    lines.push('Full Fix Pack (robots.txt + llms.txt + llms-full.txt + JSON-LD + Cloudflare rules):');
    lines.push(`  ${fixPackUrl}`);
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const HELP_TEXT = `GeoPulse CLI ${CLI_VERSION} — AI-Search (GEO) readiness auditor (zero dependencies)

Usage:
  geopulse <domain-or-url> [options]

Options:
  --json              Print the raw audit result as JSON
  --timeout=<ms>      Per-request timeout (default ${REQUEST_TIMEOUT_MS})
  --fail-under=<n>    Exit with code 1 when the score is below <n>
  --no-fix-pack       Hide the Fix Pack link in the text report
  -h, --help          Show this help
  -v, --version       Show the CLI version

Examples:
  node bin/geopulse.mjs stripe.com
  node bin/geopulse.mjs https://example.com --json
  node bin/geopulse.mjs example.com --fail-under=70

Full Fix Pack: ${FIX_PACK_URL}`;

export function parseArgs(argv) {
  const args = {
    target: '',
    json: false,
    help: false,
    version: false,
    timeoutMs: REQUEST_TIMEOUT_MS,
    failUnder: null,
    fixPack: true,
  };
  for (const raw of Array.isArray(argv) ? argv : []) {
    const arg = String(raw);
    if (arg === '--json') args.json = true;
    else if (arg === '--no-fix-pack') args.fixPack = false;
    else if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg === '-v' || arg === '--version') args.version = true;
    else if (arg.startsWith('--timeout=')) {
      const value = Number(arg.slice('--timeout='.length));
      if (Number.isFinite(value) && value > 0) args.timeoutMs = value;
    } else if (arg.startsWith('--fail-under=')) {
      const value = Number(arg.slice('--fail-under='.length));
      if (Number.isFinite(value)) args.failUnder = value;
    } else if (!arg.startsWith('-') && !args.target) {
      args.target = arg;
    }
  }
  return args;
}

/**
 * CLI entry point. Returns the process exit code.
 * `options.fetchImpl` / `options.log` exist for offline testing.
 */
export async function main(argv = [], options = {}) {
  const log = typeof options.log === 'function' ? options.log : (msg) => console.log(msg);
  const args = parseArgs(argv);

  if (args.help) {
    log(HELP_TEXT);
    return 0;
  }
  if (args.version) {
    log(CLI_VERSION);
    return 0;
  }
  if (!args.target) {
    log('ERROR: missing target domain. Usage: geopulse <domain-or-url>');
    return 2;
  }

  let result;
  try {
    result = await auditSite(args.target, {
      fetchImpl: options.fetchImpl,
      timeoutMs: args.timeoutMs,
    });
  } catch (err) {
    log(`ERROR: audit failed — ${err?.message || String(err)}`);
    return 2;
  }

  if (args.json) {
    log(JSON.stringify(result, null, 2));
  } else {
    log(formatReport(result, { showFixPack: args.fixPack }));
  }

  if (args.failUnder !== null && result.score < args.failUnder) {
    log(`SCORE_BELOW_THRESHOLD: ${result.score} < ${args.failUnder}`);
    return 1;
  }
  return 0;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
