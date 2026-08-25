'use strict';

const { loadState, saveState } = require('./state');
const experience = require('./experienceEngine');
const habits = require('./habitEngine');
const goals = require('./goalManager');

function ensure(state) {
  state.planner = state.planner || {
    strategy: 'balanced',
    strategies: {
      balanced: { rewardScale: 1, riskPenalty: 1, timePenalty: 1 },
      cautious: { rewardScale: 0.9, riskPenalty: 1.5, timePenalty: 1.1 },
      efficient: { rewardScale: 1.2, riskPenalty: 0.9, timePenalty: 0.8 },
      exploratory: { rewardScale: 1.15, riskPenalty: 0.7, timePenalty: 0.9 }
    },
    switches: [],
    lastSwitchAt: 0
  };
  state.planner.strategies = state.planner.strategies || {};
  return state.planner;
}

function chooseStrategy(snapshot, candidates) {
  const state = loadState();
  const planner = ensure(state);
  const health = snapshot.health == null ? 20 : snapshot.health;
  const food = snapshot.food == null ? 20 : snapshot.food;
  const night = snapshot.timeOfDay > 12500 && snapshot.timeOfDay < 23500;
  const crowded = candidates.filter(c => /combat|player/i.test(c.name || '')).length > 0;

  let desired = 'balanced';
  if (health <= 8 || food <= 5 || night) desired = 'cautious';
  else if ((snapshot.emptySlots || 36) <= 2) desired = 'efficient';
  else if (crowded) desired = 'cautious';
  else if (candidates.some(c => c.action === 'explore')) desired = 'exploratory';

  if (planner.strategy !== desired && Date.now() - (planner.lastSwitchAt || 0) > 15000) {
    planner.switches.push({ from: planner.strategy, to: desired, at: Date.now(), reason: { health, food, night, crowded } });
    planner.switches = planner.switches.slice(-60);
    planner.strategy = desired;
    planner.lastSwitchAt = Date.now();
    saveState(state);
  }
  return planner.strategy;
}

function adaptCandidates(bot, snapshot, candidates) {
  const strategy = chooseStrategy(snapshot, candidates);
  const state = loadState();
  const planner = ensure(state);
  const profile = planner.strategies[strategy] || planner.strategies.balanced;
  const context = experience.contextKey(snapshot);
  const adjusted = candidates.map(c => {
    const risk = c.risk || 0;
    const time = c.timeCost || 0;
    const learned = experience.suggestAdjustment(c, snapshot);
    const habit = habits.preference(c.action || c.name, context);
    const intent = c.intentBoost || 0;
    let score = c.score;
    score += learned + habit + intent;
    score *= profile.rewardScale;
    score -= risk * profile.riskPenalty;
    score -= time * profile.timePenalty;
    if (strategy === 'cautious' && /explore|mine|wood/.test(c.action)) score -= 4;
    if (strategy === 'exploratory' && c.action === 'explore') score += 8;
    return { ...c, plannerStrategy: strategy, learnedAdjustment: learned, habitAdjustment: habit, score };
  });
  adjusted.sort((a, b) => b.score - a.score);
  return adjusted;
}

function updateFromOutcome(goal, result, context) {
  const state = loadState();
  const planner = ensure(state);
  const strategy = planner.strategy;
  const reward = result && result.reward != null ? result.reward : (result && result.success ? 5 : -5);
  const key = `${strategy}|${goal && (goal.name || goal.action)}`;
  const current = planner.strategies[strategy] || planner.strategies.balanced;
  const rate = 0.08;
  if (reward > 0) current.rewardScale = Math.min(1.5, current.rewardScale + rate);
  if (reward < 0) current.riskPenalty = Math.min(2.0, current.riskPenalty + rate * 0.5);
  current.lastOutcome = { key, reward, context, at: Date.now() };
  saveState(state);
}

module.exports = { adaptCandidates, chooseStrategy, updateFromOutcome };
