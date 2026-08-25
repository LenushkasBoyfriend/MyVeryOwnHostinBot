'use strict';

const { countItem } = require('./utils');
const { loadState, saveState } = require('./state');
const acquisition = require('./acquisitionEngine');

const STRUCTURE_HINTS = {
  village: ['bread', 'wheat', 'carrot', 'potato', 'books', 'emerald', 'saddle'],
  ruined_portal: ['obsidian', 'crying_obsidian', 'gold', 'flint_and_steel'],
  shipwreck: ['map', 'paper', 'iron_ingot', 'gold_ingot', 'emerald'],
  desert_pyramid: ['gold_ingot', 'diamond', 'emerald', 'bone', 'rotten_flesh'],
  jungle_temple: ['gold_ingot', 'diamond', 'emerald', 'redstone'],
  stronghold: ['ender_pearl', 'iron_ingot', 'gold_ingot', 'books'],
  bastion: ['gold_ingot', 'ancient_debris', 'crying_obsidian'],
  fortress: ['blaze_rod', 'nether_wart'],
  end_city: ['diamond', 'elytra', 'shulker_shell']
};

const TRADE_HINTS = {
  emerald: ['farmers', 'fletchers', 'clerics'],
  diamond_gear: ['armorers', 'toolsmiths', 'weaponsmiths'],
  books: ['librarians'],
  redstone: ['clerics'],
  glowstone_dust: ['clerics']
};

function inferEntityDrops(mcData) {
  const drops = {};
  const mobs = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'blaze', 'ghast', 'slime', 'cow', 'pig', 'sheep', 'chicken', 'rabbit'];
  for (const m of mobs) if (mcData?.mobsByName?.[m]) drops[m] = true;
  return drops;
}

function enrichItem(item, plan, mcData) {
  const name = String(item).toLowerCase();
  const methods = [{ method: plan.method, confidence: 0.55, source: 'heuristic' }];
  if (/^(diamond|emerald|gold|iron|copper|coal|lapis|redstone)/.test(name)) methods.push({ method: 'mine_or_trade', confidence: 0.45, source: 'heuristic' });
  if (/gear|sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots/.test(name)) methods.push({ method: 'craft_or_upgrade', confidence: 0.6, source: 'recipe-graph' });
  for (const [structure, items] of Object.entries(STRUCTURE_HINTS)) if (items.some(x => name.includes(x) || x === name)) methods.push({ method: 'structure_loot', structure, confidence: 0.5, source: 'structure-hints' });
  for (const [target, professions] of Object.entries(TRADE_HINTS)) if (name.includes(target)) methods.push({ method: 'villager_trade', professions, confidence: 0.45, source: 'trade-hints' });
  return { item: name, methods, mobDropHints: inferEntityDrops(mcData), learnedSources: [] };
}

function buildFullGraph(bot, mcData, options = {}) {
  const base = acquisition.buildAcquisitionGraph(bot, mcData, options);
  const enriched = {};
  for (const item of Object.keys(base.catalog || {})) enriched[item] = enrichItem(item, base.graph?.[item] || { method: base.catalog[item].primaryMethod }, mcData);
  const state = loadState();
  const learned = state.knowledge?.learnedTopics || {};
  return {
    version: 3,
    generatedAt: Date.now(),
    itemCount: base.itemCount,
    graph: base.graph,
    catalog: base.catalog,
    enriched,
    learnedTopicCount: Object.keys(learned).length,
    structureHints: STRUCTURE_HINTS,
    tradeHints: TRADE_HINTS
  };
}

function findBestRoute(graph, itemName, available = {}) {
  const entry = graph?.enriched?.[itemName] || null;
  if (!entry) return null;
  const candidates = entry.methods.slice().sort((a, b) => (available[a.method] ? -1 : 0) - (available[b.method] ? -1 : 0) || b.confidence - a.confidence);
  return candidates[0] || null;
}

function recordAcquisitionOutcome(item, method, success, details = {}) {
  const state = loadState();
  state.acquisitionLearning = state.acquisitionLearning || { methods: {}, recent: [] };
  const key = `${item}:${method}`;
  const old = state.acquisitionLearning.methods[key] || { attempts: 0, successes: 0, confidence: 0.5 };
  old.attempts += 1; if (success) old.successes += 1;
  const observed = old.successes / old.attempts;
  old.confidence = Math.max(0.05, Math.min(0.98, old.confidence * 0.7 + observed * 0.3));
  state.acquisitionLearning.methods[key] = old;
  state.acquisitionLearning.recent.push({ item, method, success, details, at: Date.now() });
  state.acquisitionLearning.recent = state.acquisitionLearning.recent.slice(-100);
  saveState(state);
  return old;
}

module.exports = { STRUCTURE_HINTS, TRADE_HINTS, buildFullGraph, findBestRoute, recordAcquisitionOutcome };
