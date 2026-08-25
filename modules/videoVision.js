'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { log } = require('./utils');
const { spawnSync } = require('child_process');

const CACHE_DIR = path.join(__dirname, '..', '.video_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function requestBuffer(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(url, { headers: { 'User-Agent': 'MinecraftSurvivalBrain/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(requestBuffer(new URL(res.headers.location, url).toString(), timeoutMs));
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request-timeout')));
    req.on('error', reject);
  });
}

function extractVideoId(input) {
  try {
    const u = new URL(input);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0];
    return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
  } catch (_) {
    const m = String(input).match(/[A-Za-z0-9_-]{11}/);
    return m ? m[0] : null;
  }
}

async function fetchThumbnail(videoId, quality = 'maxresdefault') {
  const id = extractVideoId(videoId);
  if (!id) return null;
  const out = path.join(CACHE_DIR, `${id}-${quality}.jpg`);
  if (fs.existsSync(out)) return out;
  const url = `https://i.ytimg.com/vi/${id}/${quality}.jpg`;
  try {
    const data = await requestBuffer(url);
    if (data.length < 1000) return null;
    fs.writeFileSync(out, data);
    return out;
  } catch (e) {
    log('Vision', `Thumbnail alınamadı: ${e.message}`);
    return null;
  }
}

async function analyzeImageWithOpenAI() {
  return null;
}


function commandExists(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 5000 });
  return r.status === 0;
}

function buildStoryboard(videoUrl, videoId, cfg = {}) {
  if (cfg.enableVideoDownload !== true) return [];
  if (!commandExists('yt-dlp') || !commandExists('ffmpeg')) return [];
  const work = path.join(CACHE_DIR, `${videoId}-storyboard`);
  fs.mkdirSync(work, { recursive: true });
  const videoFile = path.join(work, 'video.mp4');
  const framesDir = path.join(work, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  if (!fs.existsSync(videoFile)) {
    const r = spawnSync('yt-dlp', ['--no-playlist', '-f', 'worst[ext=mp4]/worst', '--max-filesize', String(cfg.maxVideoBytes || 80 * 1024 * 1024), '-o', videoFile, videoUrl], { timeout: cfg.videoDownloadTimeoutMs || 180000, stdio: 'ignore' });
    if (r.status !== 0 || !fs.existsSync(videoFile)) return [];
  }
  const frameCount = Math.max(2, Math.min(8, Number(cfg.storyboardFrames || 6)));
  const pattern = path.join(framesDir, 'frame-%02d.jpg');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', videoFile, '-vf', `select='not(mod(n\,${Math.max(1, Math.floor(100 / frameCount))}))',scale=640:-1`, '-frames:v', String(frameCount), pattern], { timeout: 120000, stdio: 'ignore' });
  if (r.status !== 0) return [];
  return fs.readdirSync(framesDir).filter(x => x.endsWith('.jpg')).sort().map(x => path.join(framesDir, x)).slice(0, frameCount);
}

async function analyzeVideoVisually() {
  return { available: false, reason: 'external AI-disabled', storyboardFrames: [], vision: null };
}


module.exports = { extractVideoId, fetchThumbnail, analyzeVideoVisually };
