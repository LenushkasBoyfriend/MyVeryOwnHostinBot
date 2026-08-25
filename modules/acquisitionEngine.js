'use strict';

const { countItem } = require('./utils');
const { buildRecipeGraph } = require('./inventory');

const COMMON_BLOCK_SOURCES = {
  oak_log: 'tree', spruce_log: 'tree', birch_log: 'tree', jungle_log: 'tree', acacia_log: 'tree', dark_oak_log: 'tree', mangrove_log: 'tree', cherry_log: 'tree',
  cobblestone: 'stone', stone: 'stone', smooth_stone: 'smelt', coal_ore: 'mine', deepslate_coal_ore: 'mine', iron_ore: 'mine', deepslate_iron_ore: 'mine',
  copper_ore: 'mine', gold_ore: 'mine', diamond_ore: 'mine', deepslate_diamond_ore: 'mine', redstone_ore: 'mine', deepslate_redstone_ore: 'mine', lapis_ore: 'mine',
  wheat_seeds: 'grass_or_harvest', carrot: 'village_or_farm', potato: 'village_or_farm', beetroot_seeds: 'village_or_farm', sugar_cane: 'river_or_shore', bamboo: 'jungle_or_village',
  sand: 'desert_or_beach', gravel: 'river_or_gravel', clay_ball: 'clay', raw_beef: 'animal', raw_porkchop: 'animal', raw_chicken: 'animal', raw_mutton: 'animal',
  cod: 'fishing', salmon: 'fishing', tropical_fish: 'fishing', pufferfish: 'fishing', leather: 'animal', feather: 'animal', string: 'mob_drop', bone: 'mob_drop',
  ender_pearl: 'enderman', blaze_rod: 'blaze', ghast_tear: 'ghast', slime_ball: 'slime', gunpowder: 'creeper_or_farm', prismarine_shard: 'guardian',
  nether_quartz_ore: 'nether_mine', ancient_debris: 'nether_mine', netherrack: 'nether_mine', soul_sand: 'nether_mine', glowstone_dust: 'nether_or_trade',
  obsidian: 'lava_water_or_end_chest', crying_obsidian: 'piglin_trade_or_ruined_portal', saddle: 'structure_or_fishing_or_trade', name_tag: 'structure_or_fishing_or_trade'
};

const SOURCE_HINTS = {
  craft: 'craft', smelt: 'smelt', mine: 'mine', tree: 'tree', fishing: 'fishing', mob_drop: 'mob_drop',
  villager_trade: 'villager_trade', structure_loot: 'structure_loot', village_or_farm: 'village_or_farm',
  grass_or_harvest: 'grass_or_harvest', river_or_shore: 'river_or_shore', desert_or_beach: 'desert_or_beach',
  animal: 'animal', enderman: 'mob_drop', blaze: 'mob_drop', ghast: 'mob_drop', slime: 'mob_drop', guardian: 'mob_drop',
  nether_mine: 'nether_mine', nether_or_trade: 'nether_or_trade', piglin_trade_or_ruined_portal: 'piglin_trade_or_structure', structure_or_fishing_or_trade: 'structure_or_fishing_or_trade',
  lava_water_or_end_chest: 'lava_water_or_end'
};

function normalizeName(n) { return String(n || '').toLowerCase().trim(); }

function recipeCandidates(mcData, itemName) {
  const graph = buildRecipeGraph(mcData);
  return graph[normalizeName(itemName)] || [];
}

function classifyAcquisition(mcData, itemName) {
  const n = normalizeName(itemName);
  const recipes = recipeCandidates(mcData, n);
  if (recipes.length) return { method: 'craft', alternatives: ['craft'], recipes: recipes.length };
  const explicit = COMMON_BLOCK_SOURCES[n];
  if (explicit) return { method: explicit, alternatives: [explicit] };
  if (/(_ore|ore)$/.test(n) || /raw_/.test(n)) return { method: 'mine', alternatives: ['mine', 'smelt'] };
  if (/_log$|_stem$|_hyphae$/.test(n)) return { method: 'tree', alternatives: ['tree'] };
  if (/(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$/.test(n)) return { method: 'craft', alternatives: ['craft', 'upgrade'] };
  if (/(fish|rod)$/.test(n)) return { method: 'fishing', alternatives: ['fishing'] };
  if (/(spawn_egg|banner_pattern)/.test(n)) return { method: 'creative-only-or-loot', alternatives: ['structure_loot'] };
  return { method: 'learn-or-explore', alternatives: ['structure_loot', 'villager_trade', 'mob_drop', 'learn-or-explore'] };
}

function planItem(bot, mcData, itemName, count = 1, maxDepth = 8, seen = new Set()) {
  const n = normalizeName(itemName);
  const have = countItem(bot, n);
  if (have >= count) return { item: n, need: 0, have, method: 'inventory', steps: [] };
  if (seen.has(n) || maxDepth <= 0) {
    const c = classifyAcquisition(mcData, n);
    return { item: n, need: count - have, have, method: c.method, alternatives: c.alternatives, steps: [{ item: n, method: c.method, need: count - have }] };
  }
  seen.add(n);
  const recipes = recipeCandidates(mcData, n);
  if (recipes.length) {
    const ranked = recipes.slice().sort((a, b) => (a.ingredients?.length || 99) - (b.ingredients?.length || 99));
    const candidate = ranked[0];
    const steps = [];
    for (const ingredient of candidate.ingredients || []) {
      const sub = planItem(bot, mcData, ingredient, 1, maxDepth - 1, new Set(seen));
      steps.push(...sub.steps);
    }
    steps.push({ item: n, method: 'craft', need: count - have, ingredients: candidate.ingredients || [] });
    seen.delete(n);
    return { item: n, need: count - have, have, method: 'craft', steps, alternatives: recipes.length > 1 ? ['craft-other-recipe'] : [] };
  }
  const c = classifyAcquisition(mcData, n);
  seen.delete(n);
  return { item: n, need: count - have, have, method: c.method, alternatives: c.alternatives, steps: [{ item: n, method: c.method, need: count - have }] };
}

function buildItemKnowledge(mcData) {
  const items = {};
  for (const item of (mcData?.itemsArray || [])) {
    const c = classifyAcquisition(mcData, item.name);
    const recipeCount = recipeCandidates(mcData, item.name).length;
    items[item.name] = {
      craftable: recipeCount > 0,
      recipeCount,
      primaryMethod: c.method,
      alternatives: c.alternatives,
      methods: c.method === 'craft' ? ['craft', 'learn-or-explore'] : [c.method, 'learn-or-explore']
    };
  }
  return items;
}

function buildAcquisitionGraph(bot, mcData, options = {}) {
  const graph = buildItemKnowledge(mcData);
  const requested = options.items || Object.keys(graph);
  const result = {};
  for (const item of requested) result[item] = planItem(bot, mcData, item, options.defaultCount || 1, options.maxDepth || 6);
  return { generatedAt: Date.now(), itemCount: Object.keys(graph).length, graph: result, catalog: graph };
}

module.exports = { planItem, buildItemKnowledge, buildAcquisitionGraph, classifyAcquisition, COMMON_BLOCK_SOURCES, SOURCE_HINTS };
