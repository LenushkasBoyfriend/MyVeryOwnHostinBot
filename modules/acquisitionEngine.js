'use strict';

const { countItem } = require('./utils');
const { buildRecipeGraph } = require('./inventory');

const COMMON_BLOCK_SOURCES = {
  oak_log: 'tree', spruce_log: 'tree', birch_log: 'tree', jungle_log: 'tree', acacia_log: 'tree', dark_oak_log: 'tree',
  cobblestone: 'stone', stone: 'stone', coal_ore: 'mine', deepslate_coal_ore: 'mine', iron_ore: 'mine', deepslate_iron_ore: 'mine',
  copper_ore: 'mine', gold_ore: 'mine', diamond_ore: 'mine', deepslate_diamond_ore: 'mine', redstone_ore: 'mine',
  wheat_seeds: 'grass_or_harvest', carrot: 'village_or_farm', potato: 'village_or_farm', sugar_cane: 'river_or_shore',
  sand: 'desert_or_beach', gravel: 'river_or_gravel', clay_ball: 'clay', raw_beef: 'animal', raw_porkchop: 'animal', raw_chicken: 'animal'
};

function planItem(bot, mcData, itemName, count = 1, maxDepth = 6, seen = new Set()) {
  const have = countItem(bot, itemName);
  if (have >= count) return { item: itemName, need: 0, have, method: 'inventory', steps: [] };
  if (seen.has(itemName) || maxDepth <= 0) return { item: itemName, need: count - have, have, method: 'unknown', steps: [] };
  seen.add(itemName);

  const graph = buildRecipeGraph(mcData);
  const recipes = graph[itemName] || [];
  if (recipes.length) {
    const candidate = recipes.find(r => r.ingredients.every(i => !seen.has(i))) || recipes[0];
    const steps = [];
    for (const ingredient of candidate.ingredients) {
      const sub = planItem(bot, mcData, ingredient, 1, maxDepth - 1, new Set(seen));
      steps.push(...sub.steps, { item: ingredient, method: sub.method, need: sub.need });
    }
    steps.push({ item: itemName, method: 'craft', need: count, ingredients: candidate.ingredients });
    seen.delete(itemName);
    return { item: itemName, need: count - have, have, method: 'craft', steps };
  }

  const source = COMMON_BLOCK_SOURCES[itemName];
  seen.delete(itemName);
  return { item: itemName, need: count - have, have, method: source || 'learn-or-explore', steps: [{ item: itemName, method: source || 'learn-or-explore', need: count - have }] };
}

function buildItemKnowledge(mcData) {
  const items = {};
  const graph = buildRecipeGraph(mcData);
  for (const item of (mcData?.itemsArray || [])) {
    const recipes = graph[item.name] || [];
    items[item.name] = {
      craftable: recipes.length > 0,
      recipeCount: recipes.length,
      methods: recipes.length ? ['craft'] : [COMMON_BLOCK_SOURCES[item.name] || 'learn-or-explore']
    };
  }
  return items;
}

module.exports = { planItem, buildItemKnowledge, COMMON_BLOCK_SOURCES };
