'use strict';

/*
 * Learned Build Pipeline:
 * research -> select trusted source -> make a bounded build plan -> gather
 * prerequisites -> build with safe templates -> verify -> record experiment.
 *
 * This is deliberately conservative: captions and text sources can teach a plan,
 * but the bot does not pretend it can infer arbitrary 3-D geometry from prose.
 * Known farm/build templates are executed directly; unknown techniques are saved
 * as plans for later experimentation.
 */

const { Vec3, sleep, log, countItem, safePlace, gotoPos } = require('./utils');
const { loadState, saveState } = require('./state');
const knowledge = require('./knowledgeEngine');
const acquisition = require('./acquisitionEngine');
const gathering = require('./gathering');

function pickLearnedSource(topic, tag) {
  const db = knowledge.getKnowledge(topic || '');
  const sources = Array.isArray(db.sources) ? db.sources : [];
  const candidates = sources.filter(s => !tag || (s.tags || []).includes(tag));
  candidates.sort((a, b) => Number(b.analysis?.confidence || 0) - Number(a.analysis?.confidence || 0));
  return candidates[0] || sources[0] || null;
}

function materialPlanFromSource(source) {
  const materials = Array.isArray(source?.analysis?.materials) ? source.analysis.materials : [];
  const facts = Array.isArray(source?.materials) ? source.materials : [];
  return [...new Set([...materials, ...facts].map(String))]
    .map(s => s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''))
    .filter(Boolean)
    .slice(0, 40);
}

async function gatherMaterial(bot, mcData, itemName, amount = 1) {
  if (countItem(bot, itemName) >= amount) return true;
  if (/(_log|_stem|_hyphae)$/.test(itemName)) {
    await gathering.gatherWood(bot, mcData, Math.max(amount, 12));
    return countItem(bot, itemName) >= amount || countItem(bot, i => /(_log|_stem|_hyphae)$/.test(i.name)) >= amount;
  }
  if (/stone|cobble|deepslate/.test(itemName)) {
    await gathering.mineStone(bot, mcData, Math.max(amount, 32));
    return countItem(bot, itemName) >= amount || countItem(bot, i => /stone|cobble|deepslate/.test(i.name)) >= amount;
  }
  const source = acquisition.COMMON_BLOCK_SOURCES[itemName];
  if (source === 'mine') {
    await gathering.stripMineForOres(bot, mcData, [itemName], Math.max(amount, 8), -40, 140);
    return countItem(bot, itemName) >= amount;
  }
  if (source === 'tree') {
    await gathering.gatherWood(bot, mcData, Math.max(amount, 12));
    return countItem(bot, itemName) >= amount;
  }
  return false;
}

async function gatherMaterials(bot, mcData, materials = [], targetMultiplier = 1) {
  const results = [];
  for (const item of materials) {
    if (!mcData?.itemsByName?.[item]) continue;
    const target = Math.max(1, Math.min(128, 8 * targetMultiplier));
    const before = countItem(bot, item);
    if (before >= target) { results.push({ item, status: 'ready', count: before }); continue; }
    try {
      const okCraft = await require('./inventory').craftAnyItem(bot, mcData, item, target, { maxDepth: 6 });
      if (okCraft && countItem(bot, item) >= target) {
        results.push({ item, status: 'crafted', count: countItem(bot, item) });
        continue;
      }
    } catch (_) {}
    try {
      const okGather = await gatherMaterial(bot, mcData, item, target);
      results.push({ item, status: okGather ? 'gathered' : 'unmet', count: countItem(bot, item) });
    } catch (e) {
      results.push({ item, status: 'error', error: e.message, count: countItem(bot, item) });
    }
  }
  return results;
}

function templateFromSource(source) {
  const tags = source?.tags || [];
  if (tags.includes('food-farm')) return 'crop-farm';
  if (tags.includes('tree-farm')) return 'tree-farm';
  if (tags.includes('storage')) return 'storage-room';
  if (tags.includes('building')) return 'room-decoration';
  if (tags.includes('mob-farm')) return 'mob-farm-scaffold';
  if (tags.includes('iron-farm')) return 'iron-farm-scaffold';
  return null;
}

async function placeLine(bot, material, origin, count, axis = 'x') {
  const item = bot.inventory.items().find(i => i.name === material);
  if (!item) return 0;
  let placed = 0;
  for (let i = 0; i < count && item.count > 0; i++) {
    const target = axis === 'x' ? origin.offset(i, 0, 0) : origin.offset(0, 0, i);
    const below = bot.blockAt(target.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block') break;
    const existing = bot.blockAt(target);
    if (existing && !['air', 'cave_air'].includes(existing.name)) continue;
    if (await safePlace(bot, material, below, new Vec3(0, 1, 0))) placed++;
  }
  return placed;
}

async function buildCropFarm(bot, mcData, base, cfg = {}) {
  const center = new Vec3(base.x + 10, base.y, base.z);
  const crop = cfg.preferredCrop || 'wheat';
  const seed = crop === 'wheat' ? 'wheat_seeds' : `${crop}`;
  const hoe = bot.inventory.items().find(i => /_hoe$/.test(i.name));
  if (!hoe) {
    const inv = require('./inventory');
    await inv.craftAnyItem(bot, mcData, 'stone_hoe', 1, { maxDepth: 6 });
  }
  const currentHoe = bot.inventory.items().find(i => /_hoe$/.test(i.name));
  if (!currentHoe) return { success: false, reason: 'No hoe available' };
  await bot.equip(currentHoe, 'hand');
  const seedsBefore = countItem(bot, seed);
  if (seedsBefore < 8 && crop === 'wheat') {
    try { await gathering.gatherSeeds(bot, mcData, 16); } catch (_) {}
  }
  let tilled = 0;
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const target = center.offset(dx, 0, dz);
    const ground = bot.blockAt(target);
    if (!ground || !['dirt', 'grass_block', 'farmland'].includes(ground.name)) continue;
    if (ground.name !== 'farmland') {
      try { await bot.activateBlock(ground); tilled++; } catch (_) {}
    }
  }
  const farmBlock = bot.blockAt(center);
  const seeds = bot.inventory.items().find(i => i.name === seed);
  if (seeds) {
    await bot.equip(seeds, 'hand');
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (!seeds.count) break;
      const target = center.offset(dx, 1, dz);
      const above = bot.blockAt(target);
      if (above?.name !== 'air' && above?.name !== 'cave_air') continue;
      try { await bot.placeBlock(bot.blockAt(target.offset(0, -1, 0)), new Vec3(0, 1, 0)); } catch (_) {}
    }
  }
  return { success: tilled > 0, template: 'crop-farm', tilled, seedsBefore };
}

async function buildStorageRoom(bot, mcData, base, cfg = {}) {
  const baseBuilder = require('./baseBuilder');
  const room = loadState().baseRooms?.storage;
  if (!room) return { success: false, reason: 'No storage room' };
  await baseBuilder.ensureCategoryChests(bot, mcData, base, cfg.categories || {});
  await baseBuilder.organizeChests(bot, mcData, cfg.radius || 14);
  return { success: true, template: 'storage-room' };
}

async function executeTemplate(bot, mcData, template, base, cfg = {}) {
  if (!base) return { success: false, reason: 'No base' };
  switch (template) {
    case 'crop-farm': return buildCropFarm(bot, mcData, base, cfg.farming || cfg);
    case 'storage-room': return buildStorageRoom(bot, mcData, base, cfg.storage || cfg);
    case 'room-decoration': {
      const baseBuilder = require('./baseBuilder');
      await baseBuilder.buildRooms(bot, mcData, base, cfg.base || {});
      return { success: true, template };
    }
    case 'tree-farm': {
      await gathering.gatherWood(bot, mcData, Math.max(16, cfg.woodTarget || 32));
      return { success: true, template, note: 'wood-stock prepared; template-specific planting remains bounded' };
    }
    case 'mob-farm-scaffold':
    case 'iron-farm-scaffold':
      return { success: false, template, reason: 'Source learned, but no verified safe template exists for this version/world state' };
    default: return { success: false, reason: 'Unknown template' };
  }
}

async function learnPlanBuild(bot, mcData, topic, cfg = {}) {
  const source = pickLearnedSource(topic, cfg.tag);
  if (!source) return { success: false, reason: 'No learned source available' };
  const template = templateFromSource(source);
  const materials = materialPlanFromSource(source);
  const gathered = await gatherMaterials(bot, mcData, materials.slice(0, cfg.maxMaterials || 12), 1);
  const state = loadState();
  const base = state.base;
  if (!base) return { success: false, reason: 'No base available', source: source.title, gathered };
  const result = await executeTemplate(bot, mcData, template, base, cfg);
  const plan = {
    topic, template, sourceId: source.id, sourceTitle: source.title,
    confidence: Number(source.analysis?.confidence || 0), materials, gathered,
    result, plannedAt: Date.now()
  };
  state.learnedBuilds = state.learnedBuilds || { last: null, history: [] };
  state.learnedBuilds.last = plan;
  state.learnedBuilds.history.push(plan);
  state.learnedBuilds.history = state.learnedBuilds.history.slice(-40);
  saveState(state);
  knowledge.recordExperiment(topic, { success: !!result.success, template, result });
  return plan;
}

async function autonomousBuildCycle(bot, mcData, cfg = {}) {
  const topics = cfg.topics || ['Minecraft automatic food farm tutorial', 'Minecraft item sorter storage room tutorial', 'Minecraft survival base design rooms decoration'];
  const state = loadState();
  const last = state.learnedBuilds?.last;
  const nextTopic = topics.find(t => !last || t !== last.topic) || topics[0];
  try {
    const topicKnowledge = knowledge.getKnowledge(nextTopic);
    if (!topicKnowledge.sources?.length) await knowledge.autonomousResearch(nextTopic, cfg.knowledge || {});
    return await learnPlanBuild(bot, mcData, nextTopic, cfg);
  } catch (e) {
    log('Builder', `Öğren→kur döngüsü başarısız: ${e.message}`);
    return { success: false, reason: e.message };
  }
}

module.exports = { learnPlanBuild, autonomousBuildCycle, executeTemplate, gatherMaterials, templateFromSource, materialPlanFromSource };
