'use strict';

const { loadState, saveState } = require('./state');
const { countItem } = require('./utils');

function assess(bot, mcData = null) {
  const items = bot.inventory.items();
  const state = loadState();
  const health = bot.health == null ? 20 : bot.health;
  const food = bot.food == null ? 20 : bot.food;
  const emptySlots = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 0;
  const experience = bot.experience?.level || 0;
  const danger = health <= 8 || food <= 6;
  const strengths = [];
  const weaknesses = [];
  if (countItem(bot, i => /_pickaxe$/.test(i.name)) > 0) strengths.push('mining-ready');
  else weaknesses.push('no-pickaxe');
  if (countItem(bot, i => /cooked_|bread|apple|carrot|potato/.test(i.name)) >= 8) strengths.push('food-ready');
  else weaknesses.push('low-food');
  if (emptySlots <= 2) weaknesses.push('inventory-full');
  if (!state.base) weaknesses.push('no-home');
  if (experience >= 5) strengths.push('xp-available');
  const capabilities = {
    craft: !!mcData?.itemsByName,
    build: !!state.base,
    farming: !!state.hasFarm,
    storage: Object.keys(state.storage?.categoryChests || {}).length > 0,
    enchant: !!state.enchantRoomBuilt,
    knowledge: Object.keys(state.knowledge?.learnedTopics || {}).length > 0,
    exploration: true,
    learning: true,
    thinking: true
  };
  return { health, food, emptySlots, experience, danger, strengths, weaknesses, baseKnown: !!state.base, farmKnown: !!state.hasFarm, capabilities };
}

function reflect(bot, mcData, thought = {}) {
  const state = loadState();
  const a = assess(bot, mcData);
  const reflection = { at: Date.now(), thought, strengths: a.strengths, weaknesses: a.weaknesses, capabilities: a.capabilities };
  state.awareness = state.awareness || { version: 1, capabilities: {}, reflections: [] };
  state.awareness.capabilities = a.capabilities;
  state.awareness.currentThought = thought;
  state.awareness.reflections = [...(state.awareness.reflections || []), reflection].slice(-100);
  state.selfAwareness = { ...a, lastThought: thought, updatedAt: Date.now() };
  saveState(state);
  return reflection;
}


function rememberSelf(bot, note = {}) {
  const state = loadState();
  const a = assess(bot);
  state.selfAwareness = { ...a, lastThought: note, updatedAt: Date.now() };
  state.awareness = state.awareness || { version: 1, capabilities: {}, reflections: [] };
  state.awareness.currentThought = note;
  state.awareness.capabilities = a.capabilities;
  saveState(state);
  return state.selfAwareness;
}

function statusLine(bot) {
  const a = assess(bot);
  return `HP ${a.health}/20 | food ${a.food}/20 | empty ${a.emptySlots} | XP ${a.experience} | home ${a.baseKnown ? 'yes' : 'no'} | farm ${a.farmKnown ? 'yes' : 'no'}`;
}

module.exports = { assess, rememberSelf, statusLine, reflect };
