'use strict';

/*
 * Knowledge Brain: external-source learning for Minecraft techniques.
 * - Searches YouTube using the official Data API when a key is configured.
 * - Falls back to lightweight YouTube result-page parsing when possible.
 * - Extracts available caption tracks from the video page.
 * - Optionally asks an OpenAI Responses API model to turn a transcript/article
 *   into structured Minecraft knowledge.
 * - Stores knowledge locally so the bot keeps what it learned.
 *
 * This is not unlimited access: YouTube/API providers can impose quotas,
 * authentication, rate limits and terms. The bot simply has no small built-in
 * topic limit and learns again whenever its cooldown allows it.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { loadState, saveState } = require('./state');
const { log, sleep } = require('./utils');

const KNOWLEDGE_FILE = path.join(__dirname, '..', 'knowledge_base.json');

function requestText(url, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'MinecraftSurvivalBrain/1.0', ...headers } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(requestText(new URL(res.headers.location, url).toString(), headers, timeoutMs));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) req.destroy(new Error('response-too-large'));
      });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(body);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request-timeout')));
    req.on('error', reject);
  });
}

function requestJson(url, headers = {}, timeoutMs = 20000) {
  return requestText(url, headers, timeoutMs).then(text => JSON.parse(text));
}

function loadKnowledge() {
  try {
    if (fs.existsSync(KNOWLEDGE_FILE)) return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
  } catch (e) {
    log('Knowledge', `Bilgi tabanı okunamadı: ${e.message}`);
  }
  return { version: 1, topics: {}, sources: {}, items: {}, techniques: {}, lastResearchAt: 0 };
}

function saveKnowledge(db) {
  try {
    fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    log('Knowledge', `Bilgi tabanı yazılamadı: ${e.message}`);
  }
}

function cleanText(text) {
  return String(text || '')
    .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractYoutubeId(input) {
  try {
    const u = new URL(input);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0];
    return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
  } catch (_) {
    const m = String(input).match(/[A-Za-z0-9_-]{11}/);
    return m ? m[0] : null;
  }
}

async function searchYouTube(query, cfg = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (cfg.apiKey) {
    const params = new URLSearchParams({
      part: 'snippet', type: 'video', maxResults: String(Math.min(50, cfg.maxResults || 10)),
      q, safeSearch: 'none', videoCaption: 'any', key: cfg.apiKey
    });
    const data = await requestJson(`https://www.googleapis.com/youtube/v3/search?${params}`);
    return (data.items || []).map(item => ({
      id: item.id?.videoId,
      title: cleanText(item.snippet?.title),
      description: cleanText(item.snippet?.description),
      channel: cleanText(item.snippet?.channelTitle),
      publishedAt: item.snippet?.publishedAt,
      url: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : null,
      source: 'youtube-api'
    })).filter(v => v.id);
  }

  // Fallback: parse YouTube's public result HTML. This is intentionally best-effort
  // because YouTube can change its page structure or block automated requests.
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  const html = await requestText(url);
  const out = [];
  const re = /"videoRenderer":\{"videoId":"([^"]+)"[\s\S]*?"title":\{"runs":\[\{"text":"((?:\\.|[^"\\])*)"/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) && out.length < (cfg.maxResults || 10)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], title: cleanText(m[2]), url: `https://www.youtube.com/watch?v=${m[1]}`, source: 'youtube-page' });
  }
  return out;
}

async function getYoutubeCaptions(videoId) {
  const html = await requestText(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
  const marker = html.match(/"captionTracks":(\[[\s\S]*?\]),"audioTracks"/);
  if (!marker) return { text: '', language: null, available: false };
  let tracks;
  try { tracks = JSON.parse(marker[1]); } catch (_) { return { text: '', language: null, available: false }; }
  if (!Array.isArray(tracks) || !tracks.length) return { text: '', language: null, available: false };
  const preferred = tracks.find(t => /^en/i.test(t.languageCode || '')) || tracks[0];
  if (!preferred?.baseUrl) return { text: '', language: null, available: false };
  const xml = await requestText(preferred.baseUrl);
  const chunks = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml))) chunks.push(cleanText(m[1]));
  return { text: chunks.join(' '), language: preferred.languageCode || null, available: chunks.length > 0 };
}

function extractMinecraftFacts(text, title = '') {
  const body = `${title} ${text}`.toLowerCase();
  const tags = [];
  const tagRules = [
    ['iron-farm', /iron\s+farm|villager.*iron|iron.*golem/],
    ['mob-farm', /mob\s+farm|hostile\s+mob|xp\s+farm/],
    ['food-farm', /wheat|carrot|potato|food\s+farm|crop\s+farm/],
    ['tree-farm', /tree\s+farm|wood\s+farm/],
    ['redstone', /redstone|hopper|observer|piston|sorter/],
    ['storage', /storage|sorting|item\s+sorter|chest\s+system/],
    ['villager', /villager|trading\s+hall/],
    ['mining', /branch\s+mine|strip\s+mine|ore|diamond|ancient\s+debris/],
    ['building', /base\s+design|house\s+build|underground\s+base|survival\s+base|build\s+ideas/],
    ['enchanting', /enchant|anvil|mending|unbreaking|efficiency/]
  ];
  for (const [tag, rule] of tagRules) if (rule.test(body)) tags.push(tag);
  const materials = Array.from(new Set((body.match(/\b(?:oak|spruce|birch|jungle|acacia|dark oak|stone|stone bricks|deepslate|polished deepslate|cobblestone|glass|lantern|iron|hopper|chest|barrel|redstone|observer|piston|rail|water|lava|villager|wheat|carrot|potato|bone meal)\b/g) || [])));
  return { tags, materials };
}

async function analyzeWithOpenAI(content, meta, cfg = {}) {
  const apiKey = cfg.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey || !content) return null;
  const model = cfg.openaiModel || 'gpt-5.6-luna';
  const prompt = `You are the knowledge analyst for a Minecraft survival agent.\nExtract only actionable, testable facts from the supplied source. Return JSON with: summary, prerequisites[], steps[], materials[], versionHints[], risks[], metrics[], confidence(0-1), tags[].\nDo not invent facts. Mark uncertain claims as risks or low confidence. Source title: ${meta.title || ''}\nURL: ${meta.url || ''}\nCONTENT:\n${content.slice(0, cfg.maxAnalysisChars || 50000)}`;
  const payload = JSON.stringify({ model, input: prompt });
  const json = await new Promise((resolve, reject) => {
    const req = https.request('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`OpenAI HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('OpenAI timeout')));
    req.on('error', reject);
    req.write(payload); req.end();
  });
  const text = json.output_text || (json.output || []).flatMap(x => x.content || []).map(x => x.text || '').join('\n');
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {
    return { summary: text.slice(0, 5000), prerequisites: [], steps: [], materials: [], versionHints: [], risks: ['Model returned non-JSON output'], metrics: [], confidence: 0.4, tags: [] };
  }
}

async function learnFromVideo(urlOrId, cfg = {}) {
  const id = extractYoutubeId(urlOrId);
  if (!id) throw new Error('YouTube video ID bulunamadı.');
  const meta = { id, url: `https://www.youtube.com/watch?v=${id}`, title: `YouTube ${id}` };
  const caption = await getYoutubeCaptions(id);
  const facts = extractMinecraftFacts(caption.text, meta.title);
  const ai = await analyzeWithOpenAI(caption.text, meta, cfg);
  const merged = {
    id, url: meta.url, title: meta.title, sourceType: 'youtube', learnedAt: Date.now(),
    transcriptLanguage: caption.language, transcriptAvailable: caption.available,
    tags: Array.from(new Set([...(facts.tags || []), ...((ai && ai.tags) || [])])),
    materials: Array.from(new Set([...(facts.materials || []), ...((ai && ai.materials) || [])])),
    analysis: ai || { summary: caption.text.slice(0, 2500), prerequisites: [], steps: [], risks: [], versionHints: [], metrics: [], confidence: caption.available ? 0.55 : 0.2 }
  };
  const db = loadKnowledge();
  db.sources[id] = merged;
  for (const tag of merged.tags) {
    db.topics[tag] = db.topics[tag] || { learned: 0, sources: [], confidence: 0 };
    if (!db.topics[tag].sources.includes(id)) db.topics[tag].sources.push(id);
    db.topics[tag].learned += 1;
    db.topics[tag].confidence = Math.max(db.topics[tag].confidence, Number(merged.analysis.confidence || 0));
  }
  saveKnowledge(db);
  return merged;
}

async function learnTopic(topic, cfg = {}) {
  const videos = await searchYouTube(topic, cfg);
  if (!videos.length) throw new Error(`Kaynak bulunamadı: ${topic}`);
  // Score source choice by title relevance, captions availability (when API results have it later),
  // and recency signal. Then try a few candidates instead of blindly taking the first result.
  const candidates = videos.map(v => ({ ...v, score: scoreVideo(v, topic) })).sort((a, b) => b.score - a.score);
  let lastErr = null;
  for (const candidate of candidates.slice(0, Math.min(5, candidates.length))) {
    try {
      const learned = await learnFromVideo(candidate.url, cfg);
      learned.title = candidate.title || learned.title;
      learned.channel = candidate.channel;
      learned.selectionScore = candidate.score;
      const db = loadKnowledge();
      db.sources[candidate.id] = { ...db.sources[candidate.id], ...learned };
      saveKnowledge(db);
      return learned;
    } catch (e) { lastErr = e; }
    await sleep(150);
  }
  throw lastErr || new Error('Video öğrenilemedi.');
}

function scoreVideo(video, topic) {
  const text = `${video.title || ''} ${video.description || ''}`.toLowerCase();
  const q = String(topic).toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const w of q) if (text.includes(w)) score += 2;
  if (/tutorial|guide|farm|design|automatic|survival|1\.2/.test(text)) score += 2;
  if (/shorts?/.test(text)) score -= 1;
  if (video.publishedAt) score += Math.max(0, 2 - ((Date.now() - Date.parse(video.publishedAt)) / (365 * 24 * 3600 * 1000)));
  return score;
}

function getKnowledge(topic = '') {
  const db = loadKnowledge();
  if (!topic) return { topics: db.topics, sources: db.sources, items: db.items, techniques: db.techniques };
  const key = String(topic).toLowerCase();
  return {
    topic: key,
    topicState: db.topics[key] || null,
    sources: Object.values(db.sources).filter(s => (s.tags || []).some(t => t.includes(key) || key.includes(t))).slice(-20)
  };
}

function recordExperiment(topic, result = {}) {
  const db = loadKnowledge();
  const key = String(topic).toLowerCase();
  db.topics[key] = db.topics[key] || { learned: 0, sources: [], confidence: 0 };
  const prev = Number(db.topics[key].confidence || 0);
  const outcome = result.success ? 1 : 0;
  db.topics[key].confidence = Math.max(0, Math.min(1, prev * 0.8 + outcome * 0.2));
  db.topics[key].lastExperiment = { at: Date.now(), ...result };
  saveKnowledge(db);
}

async function autonomousResearch(topic, cfg = {}) {
  try {
    const learned = await learnTopic(topic, cfg);
    log('Knowledge', `Öğrenildi: ${learned.title || topic}`);
    return learned;
  } catch (e) {
    log('Knowledge', `Araştırma başarısız (${topic}): ${e.message}`);
    return null;
  }
}

module.exports = {
  loadKnowledge, saveKnowledge, searchYouTube, getYoutubeCaptions, learnFromVideo, learnTopic,
  getKnowledge, recordExperiment, autonomousResearch, extractMinecraftFacts
};
