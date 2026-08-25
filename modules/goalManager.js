'use strict';

const { loadState, saveState } = require('./state');

const DEFAULT_GOALS = [
  { id: 'survive', type: 'survival', horizon: 'now', priority: 100, status: 'active', reason: 'Stay alive.' },
  { id: 'stable-home', type: 'home', horizon: 'long', priority: 70, status: 'active', reason: 'Maintain a safe permanent home.' },
  { id: 'equipment', type: 'progression', horizon: 'medium', priority: 62, status: 'active', reason: 'Improve equipment when resources allow.' },
  { id: 'food-reserve', type: 'economy', horizon: 'medium', priority: 58, status: 'active', reason: 'Maintain a food reserve.' },
  { id: 'sustainable-farm', type: 'economy', horizon: 'long', priority: 40, status: 'active', reason: 'Establish a self-sustaining crop farm.' },
  { id: 'fuel-reserve', type: 'economy', horizon: 'medium', priority: 48, status: 'active', reason: 'Maintain a fuel reserve.' },
  { id: 'explore', type: 'exploration', horizon: 'long', priority: 28, status: 'active', reason: 'Discover useful nearby areas.' }
];

function ensure(state) {
  state.goals = state.goals || { active: {}, history: [], lastReview: 0 };
  state.goals.active = state.goals.active || {};
  for (const goal of DEFAULT_GOALS) {
    if (!state.goals.active[goal.id]) {
      state.goals.active[goal.id] = { ...goal, createdAt: Date.now(), progress: 0, attempts: 0 };
    }
  }
  return state.goals;
}

function listGoals() {
  const state = loadState();
  const goals = ensure(state);
  saveState(state);
  return Object.values(goals.active);
}

function updateGoal(id, patch = {}) {
  const state = loadState();
  const goals = ensure(state);
  goals.active[id] = { ...(goals.active[id] || { id }), ...patch, updatedAt: Date.now() };
  saveState(state);
  return goals.active[id];
}

function completeGoal(id, result = {}) {
  const state = loadState();
  const goals = ensure(state);
  const goal = goals.active[id];
  if (!goal) return null;
  goal.status = 'completed';
  goal.completedAt = Date.now();
  goal.result = result;
  goals.history.push(goal);
  if (goals.history.length > 80) goals.history = goals.history.slice(-80);
  delete goals.active[id];
  saveState(state);
  return goal;
}

function deriveProgress(bot, snapshot) {
  const state = loadState();
  const goals = ensure(state);
  const inventory = bot && bot.inventory ? bot.inventory.items() : [];
  const count = name => inventory.filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
  const hasTool = suffix => inventory.some(i => i.name.endsWith(suffix));

  const progress = {
    'survive': Math.max(0, Math.min(1, ((snapshot.health || 20) / 20) * 0.6 + ((snapshot.food || 20) / 20) * 0.4)),
    'stable-home': state.base || state.home ? 0.8 : 0,
    'equipment': Math.min(1, (hasTool('_iron_pickaxe') ? 0.45 : 0) + (hasTool('_diamond_pickaxe') ? 0.35 : 0) + (count('netherite_ingot') > 0 ? 0.2 : 0)),
    'food-reserve': Math.min(1, (snapshot.foodItems || 0) / 24),
    'sustainable-farm': state.hasFarm ? 1 : 0,
    'fuel-reserve': Math.min(1, (snapshot.coal || 0) / 32),
    'explore': 0
  };

  for (const [id, value] of Object.entries(progress)) {
    if (goals.active[id]) goals.active[id].progress = value;
  }
  goals.lastReview = Date.now();
  saveState(state);
  return progress;
}

function selectIntent(snapshot, candidates = []) {
  const state = loadState();
  const goals = ensure(state);
  const active = Object.values(goals.active).filter(g => g.status === 'active');

  const mapped = candidates.map(c => {
    const matches = active.filter(g =>
      (c.action === 'home' && g.id === 'stable-home') ||
      ((c.action === 'tools' || c.action === 'maintenance' || c.action === 'enchant') && g.id === 'equipment') ||
      ((c.action === 'food' || c.action === 'food-stock') && g.id === 'food-reserve') ||
      (c.action === 'farm' && g.id === 'sustainable-farm') ||
      (c.action === 'fuel' && g.id === 'fuel-reserve') ||
      ((c.action === 'explore') && g.id === 'explore') ||
      ((c.action === 'survive') && g.id === 'survive')
    );
    const goalBoost = matches.length ? matches.reduce((sum, g) => sum + (g.priority || 0) * (1 - (g.progress || 0)) * 0.3, 0) : 0;
    return { ...c, intentBoost: goalBoost, intentGoal: matches[0] ? matches[0].id : null, score: c.score + goalBoost };
  });

  mapped.sort((a, b) => b.score - a.score);
  saveState(state);
  return mapped;
}

module.exports = { listGoals, updateGoal, completeGoal, deriveProgress, selectIntent };
