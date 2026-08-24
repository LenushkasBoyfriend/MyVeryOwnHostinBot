'use strict';

/*
 * Survival Brain:
 * - Builds a small, explainable state snapshot.
 * - Scores candidate goals instead of using one fixed priority chain.
 * - Keeps a persistent memory of successes, failures, locations and players.
 */

const { countItem } = require('./utils');
const experience = require('./experienceEngine');
const habits = require('./habitEngine');
const { loadState, saveState } = require('./state');

function snapshot(bot) {
  const items = bot.inventory.items();
  const food = bot.food == null ? 20 : bot.food;
  const health = bot.health == null ? 20 : bot.health;
  const pos = bot.entity && bot.entity.position;
  const emptySlots = typeof bot.inventory.emptySlotCount === 'function'
    ? bot.inventory.emptySlotCount() : 0;
  const durability = items
    .filter(i => i.maxDurability)
    .map(i => i.maxDurability - (i.durabilityUsed || 0));
  return {
    food, health, emptySlots,
    position: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null,
    timeOfDay: bot.time ? bot.time.timeOfDay : 0,
    raining: !!(bot.isRaining),
    xpLevel: bot.experience ? bot.experience.level : 0,
    itemCount: items.reduce((n, i) => n + i.count, 0),
    lowestDurability: durability.length ? Math.min(...durability) : null,
    coal: countItem(bot, 'coal') + countItem(bot, 'charcoal'),
    foodItems: countItem(bot, i => /cooked_|bread|apple|carrot|potato|beetroot|melon/.test(i.name)),
    hasPickaxe: countItem(bot, i => /_pickaxe$/.test(i.name)) > 0,
    hasWeapon: countItem(bot, i => /_(sword|axe)$/.test(i.name)) > 0
  };
}

function scoreGoals(bot, cfg, state) {
  const s = snapshot(bot);
  const scores = [];
  const add = (name, score, reason, action) => scores.push({ name, score, reason, action });

  if (s.health <= 8) add('survive', 100, 'Can is critical.', 'survive');
  if (s.food <= 6) add('food', 96, 'Hunger is critical.', 'food');
  if (s.foodItems < 8) add('food-stock', 62, 'Food reserve is low.', 'food');
  if (s.coal < 12) add('fuel', 58, 'Fuel reserve is low.', 'fuel');
  if (s.emptySlots <= 2) add('storage', 78, 'Inventory is nearly full.', 'storage');
  if (!s.hasPickaxe) add('tools', 92, 'No pickaxe is available.', 'tools');
  if (s.lowestDurability !== null && s.lowestDurability < 40) add('equipment-maintenance', 74, 'A tool is close to breaking.', 'maintenance');

  const now = s.timeOfDay;
  const night = now > 12500 && now < 23500;
  if (night && state.base) add('return-home', 70, 'Night is approaching/active.', 'home');

  if (!state.base && cfg.base && cfg.base.enabled !== false) {
    add('find-home', 68, 'No permanent home is known.', 'home');
  }

  if (state.base && Object.keys(state.baseRooms || {}).length < 4) {
    add('base-development', 52, 'Base still has unfinished functional rooms.', 'base');
  }

  if (state.base && state.storage && Date.now() - (state.storage.lastSortAt || 0) > 20 * 60 * 1000) {
    add('storage-sort', 34, 'Storage should be organized.', 'storage');
  }

  if (state.base && !state.enchantRoomBuilt && s.xpLevel >= 5) {
    add('enchant-prep', 45, 'XP is available for progression.', 'enchant');
  }

  if (state.base && cfg.learningBuilds?.enabled !== false) {
    const lb = state.learnedBuilds?.last;
    const due = !lb || Date.now() - (lb.plannedAt || 0) > (cfg.learningBuilds?.cooldownMs || 35 * 60 * 1000);
    if (due) add('learned-build', 28, 'A learned technique can be tested in the world.', 'learned-build');
  }

  // Long-term progression gets a moderate score, so urgent needs win.
  if (countItem(bot, 'diamond') < 3 && s.hasPickaxe) {
    add('progress', 38, 'Diamond reserve is low.', 'mine');
  }
  if (countItem(bot, 'iron_ingot') < 8) {
    add('iron', 48, 'Iron reserve is low.', 'mine-iron');
  }
  if (countItem(bot, i => /_log$|_stem$|_hyphae$/.test(i.name)) < 8) {
    add('wood', 42, 'Wood reserve is low.', 'wood');
  }
  if (!state.hasFarm || (state.farm && Date.now() - state.farm.lastRun > 15 * 60 * 1000)) {
    add('farming', 44, 'Sustainable food production needs attention.', 'farming');
  }

  if ((state.knowledge?.lastResearchAt || 0) + 45 * 60 * 1000 < Date.now()) {
    add('research', night ? 18 : 24, 'The knowledge base is stale; a new technique can be learned.', 'research');
  }
  add('explore', night ? 12 : 25, 'No urgent survival task dominates.', 'explore');
  scores.sort((a, b) => b.score - a.score);
  return scores;
}


function stateSnapshot(bot) {
  return snapshot(bot);
}

function chooseGoal(bot, cfg) {
  const state = loadState();
  const scores = scoreGoals(bot, cfg, state);
  // Learned experience adjusts the score without replacing the rule-based safety floor.
  for (const candidate of scores) {
    candidate.rawScore = candidate.score;
    const ctx = stateSnapshot(bot);
    candidate.learningBonus = experience.suggestAdjustment(candidate, ctx);
    candidate.habitBonus = habits.adjustment(candidate.action, ctx);
    candidate.score = candidate.score + candidate.learningBonus + candidate.habitBonus;
  }
  scores.sort((a, b) => b.score - a.score);
  let choice = scores[0];
  const urgent = choice && (choice.name === 'survive' || choice.name === 'food');
  if (!urgent && scores[1] && Math.abs(scores[0].score - scores[1].score) < 10 && Math.random() < ((cfg.decision || {}).imperfectionChance || 0.08)) {
    choice = scores[1];
  }
  state.lastDecision = {
    at: Date.now(),
    goal: choice ? choice.name : 'idle',
    reason: choice ? choice.reason : 'No candidate goal',
    scores: scores.slice(0, 8)
  };
  saveState(state);
  return choice || { name: 'idle', action: 'idle', score: 0, reason: 'No candidate goal' };
}

function rememberHabit(action, before, result) {
  habits.record(action, before, result);
}

function rememberEvent(type, data = {}) {
  const state = loadState();
  state.memory = state.memory || { events: [], locations: {}, players: {}, failures: {}, successes: {} };
  state.memory.events.push({ type, at: Date.now(), ...data });
  if (state.memory.events.length > 250) state.memory.events = state.memory.events.slice(-250);
  saveState(state);
}

function rememberFailure(key, data = {}) {
  const state = loadState();
  state.memory = state.memory || { events: [], locations: {}, players: {}, failures: {}, successes: {} };
  state.memory.failures[key] = {
    count: (state.memory.failures[key] && state.memory.failures[key].count || 0) + 1,
    last: Date.now(), ...data
  };
  saveState(state);
}

function rememberSuccess(key, data = {}) {
  const state = loadState();
  state.memory = state.memory || { events: [], locations: {}, players: {}, failures: {}, successes: {} };
  state.memory.successes[key] = {
    count: (state.memory.successes[key] && state.memory.successes[key].count || 0) + 1,
    last: Date.now(), ...data
  };
  saveState(state);
}

module.exports = { snapshot, scoreGoals, chooseGoal, rememberEvent, rememberFailure, rememberSuccess, rememberHabit, stateSnapshot, experience, habits };
