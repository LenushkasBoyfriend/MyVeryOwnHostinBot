'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sleep } = require('./utils');
const vision = require('./videoVision');
const knowledge = require('./knowledgeEngine');

const CACHE = path.join(__dirname, '..', '.video_cache', 'research');
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

function commandExists(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 5000 });
  return r.status === 0;
}

function makeStoryboardPlan(videoUrl, id, cfg = {}) {
  const frames = Number(cfg.storyboardFrames || 10);
  return { videoUrl, id, frames: Math.max(4, Math.min(frames, 24)), maxBytes: cfg.maxVideoBytes || 120 * 1024 * 1024, enabled: commandExists('yt-dlp') && commandExists('ffmpeg') };
}

function evidenceScore(evidence = {}) {
  let s = 0;
  if (evidence.transcriptAvailable) s += 0.2;
  if (evidence.visualAvailable) s += 0.2;
  if (evidence.storyboardFrames > 0) s += 0.2;
  if (evidence.analysisConfidence) s += Math.min(0.25, evidence.analysisConfidence * 0.25);
  if (evidence.versionMatches) s += 0.1;
  if (evidence.hasPlacements) s += 0.15;
  if (evidence.corroboratedSources > 1) s += Math.min(0.1, (evidence.corroboratedSources - 1) * 0.03);
  return Math.min(1, s);
}

function mergePlans(plans = []) {
  const good = plans.filter(Boolean);
  if (!good.length) return null;
  const placementMap = new Map();
  for (const p of good) for (const b of (p.blockPlacements || [])) {
    const k = `${b.x}|${b.y}|${b.z}`;
    if (!placementMap.has(k)) placementMap.set(k, b);
  }
  const steps = [];
  const seen = new Set();
  for (const p of good) for (const s of (p.steps || [])) {
    const text = typeof s === 'string' ? s : JSON.stringify(s);
    if (!seen.has(text)) { seen.add(text); steps.push(s); }
  }
  const materials = Array.from(new Set(good.flatMap(p => p.materials || [])));
  const risks = Array.from(new Set(good.flatMap(p => p.risks || [])));
  const confidence = good.reduce((a, p) => a + Number(p.confidence || 0), 0) / good.length;
  return {
    summary: good.map(p => p.summary).filter(Boolean).sort((a, b) => b.length - a.length)[0] || 'fused plan',
    materials, steps: steps.slice(0, 180), risks: risks.slice(0, 80), blockPlacements: Array.from(placementMap.values()).slice(0, 8000),
    confidence: Math.min(1, confidence + Math.min(0.2, (good.length - 1) * 0.04)),
    sourceCount: good.length,
    evidence: good.map(p => ({ id: p.id, confidence: p.confidence || 0, visual: !!p.visual, transcript: !!p.transcriptAvailable }))
  };
}

async function researchVideo(video, cfg = {}) {
  const id = vision.extractVideoId(video.id || video.url || video);
  if (!id) throw new Error('invalid-video');
  const learned = await knowledge.learnFromVideo(video.url || id, { ...cfg, enableVideoDownload: cfg.enableVideoDownload !== false });
  const storyboard = makeStoryboardPlan(learned.url, id, cfg);
  const visual = learned.visual || null;
  const analysis = learned.analysis || {};
  const evidence = {
    transcriptAvailable: !!learned.transcriptAvailable,
    visualAvailable: !!learned.visualAvailable,
    storyboardFrames: Array.isArray(visual?.storyboardFrames) ? visual.storyboardFrames.length : 0,
    analysisConfidence: Number(analysis.confidence || 0),
    versionMatches: Array.isArray(analysis.versionHints) && analysis.versionHints.length > 0,
    hasPlacements: Array.isArray(analysis.blockPlacements) && analysis.blockPlacements.length > 0,
    corroboratedSources: Number(analysis.sourceCount || 1)
  };
  return { ...learned, evidence, evidenceScore: evidenceScore(evidence), storyboardPlan: storyboard };
}

async function researchTopic(topic, cfg = {}) {
  const videos = await knowledge.searchYouTube(topic, { ...cfg, maxResults: cfg.maxResults || 12 });
  const selected = videos
    .map(v => ({ ...v, score: knowledge.scoreVideo(v, topic) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(6, videos.length));
  const researched = [];
  for (const video of selected) {
    try { researched.push(await researchVideo(video, cfg)); } catch (_) {}
    await sleep(250);
  }
  const fused = mergePlans(researched.map(r => r.analysis));
  return { topic, sources: researched, plan: fused, generatedAt: Date.now() };
}

module.exports = { researchTopic, researchVideo, mergePlans, evidenceScore, makeStoryboardPlan };
