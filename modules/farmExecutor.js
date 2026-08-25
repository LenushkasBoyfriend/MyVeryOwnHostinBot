'use strict';

const { Vec3, safePlace, sleep, countItem } = require('./utils');
const inventory = require('./inventory');
const gathering = require('./gathering');
const { loadState, saveState } = require('./state');

function validatePlan(plan) {
  const d = plan?.dimensions || {};
  if (!(d.width > 0 && d.width <= 41 && d.length > 0 && d.length <= 41 && d.height > 0 && d.height <= 20)) return { ok: false, reason: 'invalid-dimensions' };
  if (!Array.isArray(plan.blockPlacements)) return { ok: false, reason: 'missing-geometry' };
  if (plan.blockPlacements.length > 12000) return { ok: false, reason: 'too-many-placements' };
  return { ok: true };
}

function normalizeBlueprint(plan) {
  const seen = new Set();
  const out = [];
  for (const p of plan.blockPlacements || []) {
    const block = String(p.block || p.material || '').toLowerCase();
    if (!block) continue;
    const x = Number(p.x), y = Number(p.y), z = Number(p.z);
    if (![x, y, z].every(Number.isFinite)) continue;
    const key = `${x}|${y}|${z}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ x, y, z, block });
  }
  return out;
}

async function collectMaterials(bot, mcData, plan, cfg = {}) {
  const needed = {};
  for (const p of normalizeBlueprint(plan)) needed[p.block] = (needed[p.block] || 0) + 1;
  const results = [];
  for (const [item, amount] of Object.entries(needed)) {
    if (!mcData?.itemsByName?.[item]) { results.push({ item, amount, status: 'unknown-item' }); continue; }
    const have = countItem(bot, item);
    if (have >= amount) { results.push({ item, amount, have, status: 'ready' }); continue; }
    let crafted = false;
    try { crafted = await inventory.craftAnyItem(bot, mcData, item, amount, { maxDepth: cfg.maxRecipeDepth || 8 }); } catch (_) {}
    let now = countItem(bot, item);
    if (now < amount) {
      try {
        if (/log|stem|hyphae/.test(item)) await gathering.gatherWood(bot, mcData, Math.max(16, amount));
        else if (/stone|cobble|deepslate/.test(item)) await gathering.mineStone(bot, mcData, Math.max(32, amount));
        else if (/ore/.test(item)) await gathering.stripMineForOres(bot, mcData, [item], Math.max(8, amount), -40, 140);
      } catch (_) {}
      now = countItem(bot, item);
    }
    results.push({ item, amount, have: now, status: now >= amount ? (crafted ? 'crafted' : 'gathered') : 'unmet' });
  }
  return results;
}

async function placeBlueprint(bot, plan, origin, cfg = {}) {
  const valid = validatePlan(plan);
  if (!valid.ok) return { success: false, reason: valid.reason };
  const bp = normalizeBlueprint(plan);
  const max = Math.min(bp.length, Number(cfg.maxPlacements || 10000));
  let placed = 0, skipped = 0;
  const order = bp.slice(0, max).sort((a, b) => a.y - b.y || (a.x + a.z) - (b.x + b.z));
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    const target = new Vec3(origin.x + p.x, origin.y + p.y, origin.z + p.z);
    const existing = bot.blockAt(target);
    if (existing && !['air', 'cave_air', 'void_air'].includes(existing.name)) { skipped++; continue; }
    const below = bot.blockAt(target.offset(0, -1, 0));
    const held = bot.inventory.items().find(i => i.name === p.block && i.count > 0);
    if (!held || !below || below.boundingBox !== 'block') { skipped++; continue; }
    try { if (await safePlace(bot, p.block, below, new Vec3(0, 1, 0))) placed++; else skipped++; } catch (_) { skipped++; }
    if (i % 20 === 0) await sleep(60);
  }
  return { success: placed >= Math.max(1, Math.floor(order.length * 0.6)), placed, skipped, requested: order.length };
}

async function verifyFarm(bot, plan, origin) {
  const bp = normalizeBlueprint(plan).slice(0, 500);
  let present = 0;
  for (const p of bp) {
    const b = bot.blockAt(new Vec3(origin.x + p.x, origin.y + p.y, origin.z + p.z));
    if (b?.name === p.block) present++;
  }
  const ratio = bp.length ? present / bp.length : 0;
  return { verified: ratio >= 0.55, ratio, sampled: bp.length };
}

function recordExperiment(topic, phase, result) {
  const state = loadState();
  state.learnedFarms = state.learnedFarms || { last: null, history: [] };
  const entry = { topic, phase, result, at: Date.now() };
  state.learnedFarms.history.push(entry);
  state.learnedFarms.history = state.learnedFarms.history.slice(-100);
  state.learnedFarms.last = entry;
  saveState(state);
}

async function executeLearnedFarm(bot, mcData, plan, base, cfg = {}) {
  const check = validatePlan(plan);
  if (!check.ok) return { success: false, reason: check.reason };
  const origin = new Vec3(base.x + (cfg.offsetX || 12), base.y + (cfg.offsetY || 0), base.z + (cfg.offsetZ || 12));
  const materials = await collectMaterials(bot, mcData, plan, cfg);
  const prepOk = materials.filter(x => x.status === 'ready' || x.status === 'crafted' || x.status === 'gathered').length >= Math.max(1, Math.floor(materials.length * 0.75));
  recordExperiment(plan.name || plan.type || 'farm', 'materials', { prepOk, materials });
  if (!prepOk) return { success: false, reason: 'materials-not-ready', materials };
  const placed = await placeBlueprint(bot, plan, origin, cfg);
  recordExperiment(plan.name || plan.type || 'farm', 'placement', placed);
  const verified = await verifyFarm(bot, plan, origin);
  recordExperiment(plan.name || plan.type || 'farm', 'verification', verified);
  return { success: !!(placed.success && verified.verified), origin, materials, placed, verified };
}

module.exports = { validatePlan, normalizeBlueprint, collectMaterials, placeBlueprint, verifyFarm, executeLearnedFarm, recordExperiment };
