'use strict';

const { Vec3, safePlace, sleep, countItem, log } = require('./utils');
const acquisition = require('./acquisitionEngine');
const inventory = require('./inventory');
const { loadState, saveState } = require('./state');

function normalizeFarmPlan(source, fallbackTopic = '') {
  const a = source?.analysis || {};
  const tags = source?.tags || [];
  const isFood = tags.includes('food-farm') || /food|crop|wheat|carrot|potato/i.test(fallbackTopic);
  const size = a.dimensions || a.size || { width: 7, length: 7, height: 3 };
  const materials = Array.isArray(a.materials) ? a.materials : (source.materials || []);
  const phases = Array.isArray(a.steps) ? a.steps.map((s, i) => typeof s === 'string' ? { order: i + 1, action: s } : { order: i + 1, ...s }) : [];
  const placement = Array.isArray(a.blockPlacements) ? a.blockPlacements : [];
  return {
    id: `farm-${source.id || Date.now()}`,
    name: a.summary?.slice(0, 80) || source.title || fallbackTopic || 'learned-farm',
    type: isFood ? 'crop' : tags.includes('iron-farm') ? 'iron' : tags.includes('mob-farm') ? 'mob' : 'generic',
    dimensions: { width: Number(size.width || 7), length: Number(size.length || 7), height: Number(size.height || 3) },
    materials: [...new Set(materials.map(String))].slice(0, 80),
    phases,
    blockPlacements: placement.slice(0, 2500),
    prerequisites: Array.isArray(a.prerequisites) ? a.prerequisites : [],
    risks: Array.isArray(a.risks) ? a.risks : [],
    versionHints: Array.isArray(a.versionHints) ? a.versionHints : [],
    confidence: Number(a.confidence || 0),
    visual: source.visual || null,
    sourceId: source.id || null,
    sourceTitle: source.title || null
  };
}

function estimateMaterials(plan, multiplier = 1) {
  const result = {};
  for (const m of plan.materials || []) {
    const key = String(m).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!key) continue;
    result[key] = Math.max(1, Math.min(512, Math.ceil((result[key] || 0) + 8 * multiplier)));
  }
  for (const p of plan.blockPlacements || []) {
    if (!p.block) continue;
    result[p.block] = (result[p.block] || 0) + 1;
  }
  return result;
}

function verifyBounds(plan) {
  const d = plan.dimensions || {};
  return d.width > 0 && d.width <= 31 && d.length > 0 && d.length <= 31 && d.height > 0 && d.height <= 15;
}

async function prepareMaterials(bot, mcData, plan, cfg = {}) {
  const need = estimateMaterials(plan, cfg.materialMultiplier || 1);
  const results = [];
  for (const [item, amount] of Object.entries(need)) {
    if (!mcData?.itemsByName?.[item]) continue;
    const have = countItem(bot, item);
    if (have >= amount) { results.push({ item, amount, have, status: 'ready' }); continue; }
    let crafted = false;
    try { crafted = await inventory.craftAnyItem(bot, mcData, item, amount, { maxDepth: cfg.maxRecipeDepth || 8 }); } catch (_) {}
    if (crafted && countItem(bot, item) >= amount) {
      results.push({ item, amount, have: countItem(bot, item), status: 'crafted' });
      continue;
    }
    const sourcePlan = acquisition.planItem(bot, mcData, item, amount, cfg.maxRecipeDepth || 8);
    results.push({ item, amount, have: countItem(bot, item), status: 'needs-gathering', sourcePlan });
  }
  return results;
}

async function executePlacementBlueprint(bot, mcData, plan, origin, cfg = {}) {
  if (!verifyBounds(plan)) return { success: false, reason: 'unsafe-or-unknown-dimensions' };
  if (!Array.isArray(plan.blockPlacements) || plan.blockPlacements.length === 0) {
    return { success: false, reason: 'no-verified-3d-blueprint' };
  }
  let placed = 0, skipped = 0;
  const max = Math.min(plan.blockPlacements.length, cfg.maxPlacements || 2500);
  for (let i = 0; i < max; i++) {
    const p = plan.blockPlacements[i];
    const blockName = p.block || p.material;
    if (!blockName || !mcData?.itemsByName?.[blockName]) { skipped++; continue; }
    const target = new Vec3(origin.x + Number(p.x || 0), origin.y + Number(p.y || 0), origin.z + Number(p.z || 0));
    const existing = bot.blockAt(target);
    if (existing && !['air', 'cave_air'].includes(existing.name)) { skipped++; continue; }
    const below = bot.blockAt(target.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block') { skipped++; continue; }
    if (!bot.inventory.items().some(i => i.name === blockName)) { skipped++; continue; }
    try {
      if (await safePlace(bot, blockName, below, new Vec3(0, 1, 0))) placed++;
    } catch (_) { skipped++; }
    if (i % 25 === 0) await sleep(80);
  }
  return { success: placed > 0 && placed >= Math.floor(max * 0.45), placed, skipped, requested: max };
}

function chooseFarmStrategy(plan, environment = {}) {
  if (plan.type === 'crop') return environment.waterNearby ? 'irrigated-crop' : 'crop-with-water-prep';
  if (plan.type === 'iron') return environment.hasVillagers ? 'verified-iron-layout' : 'villager-prep';
  if (plan.type === 'mob') return environment.darkArea ? 'dark-mob-chamber' : 'platform-plus-darkness';
  return 'learned-blueprint';
}

function recordFarmOutcome(topic, result) {
  const state = loadState();
  state.learnedFarms = state.learnedFarms || { last: null, history: [] };
  const record = { topic, at: Date.now(), result };
  state.learnedFarms.last = record;
  state.learnedFarms.history.push(record);
  state.learnedFarms.history = state.learnedFarms.history.slice(-60);
  saveState(state);
}

module.exports = { normalizeFarmPlan, estimateMaterials, prepareMaterials, executePlacementBlueprint, chooseFarmStrategy, recordFarmOutcome };
