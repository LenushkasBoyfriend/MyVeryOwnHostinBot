'use strict';

/*
 * Experience / learning layer.
 * The bot does not "learn" by changing its source code. Instead it learns
 * from trial -> outcome -> reward and keeps compact, persistent estimates of
 * which actions work in which situations.
 */

const { loadState, saveState } = require('./state');

const DEFAULT_ACTION = {
  trials: 0,
  successes: 0,
  failures: 0,
  totalReward: 0,
  meanReward: 0,
  confidence: 0,
  lastReward: 0,
  lastAt: 0,
  lastContext: null,
  streak: 0
};

function ensure(state) {
  state.experience = state.experience || {
    actions: {},
    episodes: [],
    principles: {},
    version: 1
  };
  state.experience.actions = state.experience.actions || {};
  state.experience.episodes = state.experience.episodes || [];
  state.experience.principles = state.experience.principles || {};
  return state.experience;
}

function getAction(exp, key) {
  if (!exp.actions[key]) exp.actions[key] = { ...DEFAULT_ACTION };
  return exp.actions[key];
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function contextKey(snapshot) {
  if (!snapshot) return 'unknown';
  const time = snapshot.timeOfDay == null ? 0 : snapshot.timeOfDay;
  const dayPart = time < 4000 ? 'morning' : time < 9000 ? 'day' : time < 13000 ? 'late-day' : time < 18000 ? 'evening' : 'night';
  const danger = snapshot.health <= 8 ? 'critical' : snapshot.health <= 14 ? 'hurt' : 'safe';
  const food = snapshot.food <= 6 ? 'hungry' : snapshot.food <= 12 ? 'low-food' : 'fed';
  const space = snapshot.emptySlots <= 2 ? 'full' : snapshot.emptySlots <= 5 ? 'limited' : 'open';
  return `${dayPart}|${danger}|${food}|${space}`;
}

function contextFeatures(snapshot) {
  return {
    timeOfDay: snapshot && snapshot.timeOfDay != null ? snapshot.timeOfDay : 0,
    health: snapshot && snapshot.health != null ? snapshot.health : 20,
    food: snapshot && snapshot.food != null ? snapshot.food : 20,
    emptySlots: snapshot && snapshot.emptySlots != null ? snapshot.emptySlots : 36,
    xpLevel: snapshot && snapshot.xpLevel != null ? snapshot.xpLevel : 0,
    lowestDurability: snapshot && snapshot.lowestDurability != null ? snapshot.lowestDurability : null
  };
}

function getLearningBonus(exp, goalName, snapshot) {
  const action = getAction(exp, goalName);
  const key = contextKey(snapshot);
  const context = action.contexts && action.contexts[key];
  const base = action.meanReward || 0;
  const contextMean = context ? context.meanReward : base;
  const trials = action.trials || 0;
  // Small optimism for actions with little evidence, fading as experience grows.
  const exploration = 10 / Math.sqrt(trials + 1);
  const contextExploration = context ? 4 / Math.sqrt((context.trials || 0) + 1) : 6;
  return clamp(contextMean * 1.15 + exploration + contextExploration, -35, 35);
}

function beginEpisode(goal, snapshot) {
  const state = loadState();
  const exp = ensure(state);
  const episode = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    goal: goal.name || goal.action || 'unknown',
    action: goal.action || goal.name || 'unknown',
    startedAt: Date.now(),
    context: contextKey(snapshot),
    before: contextFeatures(snapshot),
    reward: null,
    result: null
  };
  exp.episodes.push(episode);
  if (exp.episodes.length > 120) exp.episodes = exp.episodes.slice(-120);
  saveState(state);
  return episode.id;
}

function rewardFromOutcome(before, after, result = {}) {
  let reward = 0;
  if (!before || !after) return result.success ? 8 : -8;

  if (result.success) reward += 8;
  else reward -= 8;

  if (after.health > before.health) reward += 5;
  if (after.health < before.health) reward -= Math.min(8, Math.round((before.health - after.health) * 0.7));
  if (after.food > before.food) reward += 2;
  if (after.emptySlots > before.emptySlots) reward -= 1;
  if (after.itemCount > before.itemCount) reward += Math.min(4, Math.round((after.itemCount - before.itemCount) / 8));
  if (before.lowestDurability !== null && after.lowestDurability !== null && after.lowestDurability > before.lowestDurability) reward += 2;

  const durationSec = result.durationMs ? result.durationMs / 1000 : 0;
  if (durationSec > 45) reward -= 2;
  if (durationSec > 90) reward -= 3;
  if (result.aborted) reward -= 3;

  return clamp(reward, -20, 20);
}

function updateAction(action, reward) {
  const alpha = 0.25;
  action.trials += 1;
  if (reward > 0) action.successes += 1;
  if (reward < 0) action.failures += 1;
  action.totalReward += reward;
  action.meanReward = action.meanReward * (1 - alpha) + reward * alpha;
  action.lastReward = reward;
  action.lastAt = Date.now();
  action.confidence = clamp(1 - Math.exp(-(action.trials / 10)), 0, 0.99);
  action.streak = reward >= 0 ? Math.max(0, action.streak) + 1 : Math.min(0, action.streak) - 1;
}

function finishEpisode(id, after, result = {}) {
  const state = loadState();
  const exp = ensure(state);
  const idx = exp.episodes.findIndex(e => e.id === id);
  if (idx < 0) return null;
  const episode = exp.episodes[idx];
  const reward = rewardFromOutcome(episode.before, after, result);
  const key = episode.goal || episode.action;
  const action = getAction(exp, key);
  updateAction(action, reward);
  action.lastContext = episode.context;

  action.contexts = action.contexts || {};
  const ctx = action.contexts[episode.context] || { trials: 0, successes: 0, failures: 0, meanReward: 0 };
  const alpha = 0.3;
  ctx.trials += 1;
  if (reward > 0) ctx.successes += 1;
  if (reward < 0) ctx.failures += 1;
  ctx.meanReward = ctx.meanReward * (1 - alpha) + reward * alpha;
  action.contexts[episode.context] = ctx;

  episode.finishedAt = Date.now();
  episode.reward = reward;
  episode.result = result.success ? 'success' : (result.aborted ? 'aborted' : 'failure');
  episode.after = contextFeatures(after);

  const principleKey = `${key}|${episode.context}`;
  const principle = exp.principles[principleKey] || { count: 0, meanReward: 0 };
  principle.count += 1;
  principle.meanReward = principle.meanReward * 0.7 + reward * 0.3;
  principle.lastAt = Date.now();
  exp.principles[principleKey] = principle;

  saveState(state);
  return { reward, action };
}

function suggestAdjustment(goal, snapshot) {
  const state = loadState();
  const exp = ensure(state);
  const key = goal.name || goal.action || 'unknown';
  return getLearningBonus(exp, key, snapshot);
}

function getReport(limit = 12) {
  const state = loadState();
  const exp = ensure(state);
  return Object.entries(exp.actions)
    .map(([name, data]) => ({ name, ...data, contexts: undefined }))
    .sort((a, b) => (b.meanReward - a.meanReward) || (b.trials - a.trials))
    .slice(0, limit);
}

module.exports = {
  beginEpisode,
  finishEpisode,
  suggestAdjustment,
  getReport,
  contextKey
};
