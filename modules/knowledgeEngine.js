'use strict';

/*
 * Knowledge Brain
 *
 * Learns Minecraft techniques/farms from public web pages and YouTube captions
 * when they are available. It stores structured knowledge, source confidence,
 * and practical outcomes so Survival Brain can prefer ideas that worked in the
 * bot's own world over unverified internet claims.
 *
 * No external npm dependency is required. Network access is optional; the bot
 * remains fully functional when learning is unavailable.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { loadState, saveState } = require('./state');

const MAX_SOURCE_CHARS = 180000;
const MAX_TRANSCRIPT_CHARS = 120000;
const REQUEST_TIMEOUT_MS = 15000;
const MEMORY_KEY = 'knowledge';

function ensure(state) {
  state[MEMORY_KEY] = state[MEMORY_KEY] || {
    version: 1,
    sources: {},
    topics: {},
    techniques: {},
    claims: {},
    experiments: [],
    queue: [],
    lastLearnAt: 0,
    lastSearchAt: 0
  };
  const k = state[MEMORY_KEY];
  k.sources = k.sources || {};
  k.topics = k.topics || {};
  k.techniques = k.techniques || {};
  k.claims = k.claims || {};
  k.experiments = k.experiments || [];
  k.queue = k.queue || [];
  return k;
}

function normalize(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<br\s*\/?>(\r?\n)?/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function clampText(text, max) {
  const clean = normalize(text);
  return clean.length > max ? clean.slice(0, max) : clean;
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`Invalid URL: ${url}`)); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Only http/https URLs are supported.'));
    if (redirects > 4) return reject(new Error('Too many redirects.'));

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Minecraft-Survival-Brain/5.0)',
        'Accept-Language': 'en-US,en;q=0.8,tr;q=0.7'
      }
    }, res => {
      const location = res.headers.location;
      if (location && [301, 302, 303, 307, 308].includes(res.statusCode || 0)) {
        res.resume();
        return request(new URL(location, parsed).href, redirects + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_SOURCE_CHARS + 20000) req.destroy();
      });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve({ body: data.slice(0, MAX_SOURCE_CHARS), contentType: res.headers['content-type'] || '' });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out.')));
    req.on('error', reject);
  });
}

function shaish(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

function youtubeId(input) {
  try {
    const u = new URL(input);
    if (u.hostname.includes('youtu.be')) return u.pathname.replace(/^\//, '').split('/')[0] || null;
    if (u.hostname.includes('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' || parts[0] === 'embed') return parts[1] || null;
    }
  } catch (_) {}
  return null;
}

function extractJsonObjectAfter(source, marker) {
  const idx = source.indexOf(marker);
  if (idx < 0) return null;
  const start = source.indexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseYoutubeCaptions(html) {
  const jsonText = extractJsonObjectAfter(html, 'ytInitialPlayerResponse');
  if (!jsonText) return null;
  let player;
  try { player = JSON.parse(jsonText); } catch (_) { return null; }
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return null;
  const preferred = tracks.find(t => /^(en|tr)(-|$)/i.test(t.languageCode || '')) || tracks[0];
  if (!preferred?.baseUrl) return null;
  return decodeHtmlEntities(preferred.baseUrl);
}

function parseTranscriptXml(xml) {
  const chunks = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml))) {
    const text = decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim();
    if (text) chunks.push(text);
    if (chunks.join(' ').length > MAX_TRANSCRIPT_CHARS) break;
  }
  return clampText(chunks.join(' '), MAX_TRANSCRIPT_CHARS);
}

async function fetchYouTube(url) {
  const id = youtubeId(url);
  if (!id) throw new Error('Not a supported YouTube URL.');
  const page = await request(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`);
  const titleMatch = page.body.match(/<title>([\s\S]*?)<\/title>/i);
  const title = normalize(titleMatch ? titleMatch[1].replace(/ - YouTube\s*$/i, '') : `YouTube ${id}`);
  let transcript = null;
  const captionUrl = parseYoutubeCaptions(page.body);
  if (captionUrl) {
    try {
      const caption = await request(captionUrl);
      transcript = parseTranscriptXml(caption.body);
    } catch (_) {}
  }
  return {
    type: 'youtube', id, title,
    url,
    content: transcript || normalize(page.body).slice(0, MAX_TRANSCRIPT_CHARS),
    transcriptAvailable: !!transcript
  };
}

function extractTitle(html, fallback) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return normalize(match ? match[1] : fallback).slice(0, 300) || fallback;
}

function extractTextFromHtml(html) {
  return clampText(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' '), MAX_SOURCE_CHARS);
}

function sourceType(url) {
  const id = youtubeId(url);
  if (id) return 'youtube';
  return 'web';
}

function scoreConfidence(item, content) {
  let score = item.type === 'youtube' && item.transcriptAvailable ? 0.78 : (item.type === 'youtube' ? 0.5 : 0.62);
  const text = String(content || '').toLowerCase();
  if (/minecraft|farm|iron|redstone|villager|mob|hopper|piston|enchant|diamond/.test(text)) score += 0.08;
  if (/1\.21|1\.20|1\.19/.test(text)) score += 0.04;
  return Math.min(0.95, score);
}

function inferTechniques(text, source) {
  const lower = String(text || '').toLowerCase();
  const rules = [
    ['iron-farm', /iron farm|demir farm|iron golem.*farm/],
    ['sugarcane-farm', /sugar cane|şeker kamışı|sugarcane.*farm/],
    ['bamboo-farm', /bamboo farm|bambu farm/],
    ['mob-farm', /mob farm|hostile mob farm|mob grinder/],
    ['villager-trading', /villager trading|köylü ticaret|trading hall/],
    ['branch-mining', /branch mining|strip mining|dal maden|şerit maden/],
    ['redstone-storage', /item sorter|item storage|sorting system|eşya ayır/],
    ['enchantment', /enchanting|enchantment|büyü masası|büyü/],
    ['nether-prep', /nether preparation|nether hazırl|nether portal/],
    ['food-farm', /wheat farm|carrot farm|potato farm|food farm|buğday farm|havuç farm/]
  ];
  const found = [];
  for (const [id, rx] of rules) if (rx.test(lower)) found.push({ id, title: id.replace(/-/g, ' '), sourceId: source.id });
  if (!found.length && lower.length > 1000) found.push({ id: `tech-${shaish(source.id + text.slice(0, 500))}`, title: source.title, sourceId: source.id });
  return found;
}

function learnRecord(record) {
  const state = loadState();
  const k = ensure(state);
  const sourceId = `${record.type}:${record.id || shaish(record.url)}`;
  const confidence = scoreConfidence({ type: record.type, transcriptAvailable: record.transcriptAvailable }, record.content);
  const source = {
    id: sourceId,
    type: record.type,
    url: record.url,
    title: record.title,
    learnedAt: Date.now(),
    confidence,
    transcriptAvailable: !!record.transcriptAvailable,
    excerpt: clampText(record.content, 5000)
  };
  k.sources[sourceId] = source;

  const techniques = inferTechniques(record.content, source);
  for (const t of techniques) {
    const existing = k.techniques[t.id] || { id: t.id, title: t.title, sourceIds: [], confidence: 0, attempts: 0, successes: 0, failures: 0, notes: [] };
    if (!existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId);
    existing.confidence = Math.min(0.99, Math.max(existing.confidence || 0, confidence));
    existing.updatedAt = Date.now();
    existing.notes = existing.notes || [];
    if (existing.notes.length < 8) existing.notes.push(clampText(record.content, 600));
    k.techniques[t.id] = existing;
    k.claims[`${t.id}:${sourceId}`] = { techniqueId: t.id, sourceId, confidence, createdAt: Date.now() };
  }

  const topicKey = record.topic || record.title || sourceId;
  k.topics[topicKey] = {
    topic: topicKey,
    lastLearnedAt: Date.now(),
    sources: Array.from(new Set([...(k.topics[topicKey]?.sources || []), sourceId])).slice(-20),
    techniqueIds: techniques.map(t => t.id),
    confidence: confidence
  };
  k.lastLearnAt = Date.now();
  saveState(state);
  return { source, techniques };
}

async function learnFromUrl(url, topic = null) {
  const type = sourceType(url);
  let record;
  if (type === 'youtube') record = await fetchYouTube(url);
  else {
    const page = await request(url);
    record = { type: 'web', id: shaish(url), title: extractTitle(page.body, url), url, content: extractTextFromHtml(page.body), transcriptAvailable: false };
  }
  record.topic = topic || record.title;
  return learnRecord(record);
}

async function searchWeb(query, limit = 5) {
  const q = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${q}`;
  const page = await request(url);
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(page.body)) && results.length < limit) {
    let href = m[1];
    try {
      const u = new URL(href, 'https://html.duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg) href = uddg;
    } catch (_) {}
    results.push({ url: href, title: normalize(m[2]) });
  }
  return results;
}

async function learnTopic(topic, limit = 3) {
  const state = loadState();
  const k = ensure(state);
  const searchKey = String(topic).toLowerCase().trim();
  if (!searchKey) return { topic, learned: [], searched: [] };
  const recently = k.topics[searchKey];
  if (recently && Date.now() - (recently.lastLearnedAt || 0) < 24 * 60 * 60 * 1000) {
    return { topic, learned: [], searched: [], skipped: 'recently-learned' };
  }
  const results = await searchWeb(`Minecraft ${topic} guide farm tutorial`, Math.max(limit, 3));
  const learned = [];
  for (const result of results.slice(0, limit)) {
    try {
      learned.push(await learnFromUrl(result.url, searchKey));
    } catch (e) {
      state.memory = state.memory || {};
      state.memory.events = state.memory.events || [];
      state.memory.events.push({ type: 'knowledge-fetch-failed', url: result.url, error: e.message, at: Date.now() });
    }
  }
  saveState(state);
  return { topic, learned, searched: results };
}

function recordExperiment(techniqueId, result = {}) {
  const state = loadState();
  const k = ensure(state);
  const t = k.techniques[techniqueId] || { id: techniqueId, title: techniqueId, sourceIds: [], confidence: 0.3, attempts: 0, successes: 0, failures: 0 };
  t.attempts = (t.attempts || 0) + 1;
  if (result.success) t.successes = (t.successes || 0) + 1; else t.failures = (t.failures || 0) + 1;
  const ownRate = t.attempts ? t.successes / t.attempts : 0;
  t.practicalConfidence = Math.min(0.98, 0.25 + (ownRate * 0.65) + Math.min(0.08, t.attempts * 0.01));
  t.lastExperiment = { at: Date.now(), result: { ...result } };
  k.experiments.push({ techniqueId, at: Date.now(), result: { ...result } });
  if (k.experiments.length > 150) k.experiments = k.experiments.slice(-100);
  saveState(state);
  return t;
}

function getKnowledgeForTechnique(techniqueId) {
  const state = loadState();
  const k = ensure(state);
  return k.techniques[techniqueId] || null;
}

function listTechniques() {
  const state = loadState();
  const k = ensure(state);
  return Object.values(k.techniques).sort((a, b) => ((b.practicalConfidence || b.confidence || 0) - (a.practicalConfidence || a.confidence || 0)));
}

function suggestTopics(snapshot = {}) {
  const out = [];
  if ((snapshot.coal || 0) < 12) out.push('automatic fuel farms');
  if ((snapshot.foodItems || 0) < 8) out.push('automatic food farms');
  if (!snapshot.hasPickaxe) out.push('early game mining techniques');
  if ((snapshot.xpLevel || 0) >= 5) out.push('Minecraft enchanting strategy');
  out.push('iron farm');
  out.push('villager trading');
  out.push('item sorting storage');
  return Array.from(new Set(out)).slice(0, 4);
}

async function autoLearn(snapshot, cfg) {
  if (!cfg?.knowledge?.enabled) return { skipped: 'disabled' };
  const state = loadState();
  const k = ensure(state);
  const interval = Number(cfg.knowledge.interval || 30 * 60 * 1000);
  if (Date.now() - (k.lastLearnAt || 0) < interval) return { skipped: 'cooldown' };
  const topics = suggestTopics(snapshot).slice(0, Number(cfg.knowledge.topicsPerCycle || 1));
  const results = [];
  for (const topic of topics) {
    try { results.push(await learnTopic(topic, Number(cfg.knowledge.sourcesPerTopic || 2))); }
    catch (e) { results.push({ topic, error: e.message }); }
  }
  k.lastLearnAt = Date.now();
  saveState(state);
  return { topics, results };
}

function getReport(limit = 12) {
  const state = loadState();
  const k = ensure(state);
  const techniques = listTechniques().slice(0, limit).map(t => ({
    id: t.id,
    title: t.title,
    sources: (t.sourceIds || []).length,
    externalConfidence: t.confidence,
    practicalConfidence: t.practicalConfidence || null,
    attempts: t.attempts || 0,
    successes: t.successes || 0,
    failures: t.failures || 0
  }));
  return { lastLearnAt: k.lastLearnAt, sources: Object.keys(k.sources).length, techniques };
}

module.exports = {
  learnFromUrl,
  learnTopic,
  recordExperiment,
  getKnowledgeForTechnique,
  listTechniques,
  suggestTopics,
  autoLearn,
  getReport
};
