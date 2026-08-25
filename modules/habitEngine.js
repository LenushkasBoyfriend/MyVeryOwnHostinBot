'use strict';

// Learns simple action habits from repeated outcomes in the same context.
const { loadState, saveState } = require('./state');

function bucket(snapshot = {}) {
  const food = snapshot.food == null ? 20 : snapshot.food;
  const health = snapshot.health == null ? 20 : snapshot.health;
  const tod = snapshot.timeOfDay == null ? 0 : snapshot.timeOfDay;
  const time = tod > 12500 && tod < 23500 ? 'night' : 'day';
  const risk = health <= 8 ? 'critical-health' : food <= 6 ? 'critical-food' : 'normal';
  const inv = snapshot.emptySlots != null && snapshot.emptySlots <= 2 ? 'full' : 'open';
  return `${time}|${risk}|${inv}`;
}

function ensure(state) {
  state.habits = state.habits || { version: 1, actions: {}, recent: [] };
  return state.habits;
}

function get(action, snapshot) {
  const state = loadState();
  const habits = ensure(state);
  const key = `${action}|${bucket(snapshot)}`;
  const row = habits.actions[key] || { attempts: 0, successes: 0, failures: 0, score: 0 };
  return { ...row, key };
}

function adjustment(action, snapshot) {
  const row = get(action, snapshot);
  if (row.attempts < 2) return 0;
  const successRate = row.successes / Math.max(1, row.attempts);
  // Strongly suppress repeated failures, but keep some exploration alive.
  if (row.failures >= 3 && successRate < 0.35) return -45;
  if (successRate >= 0.8) return 16;
  if (successRate >= 0.6) return 8;
  if (successRate < 0.45) return -18;
  return 0;
}

function record(action, snapshot, result = {}) {
  const state = loadState();
  const habits = ensure(state);
  const key = `${action}|${bucket(snapshot)}`;
  const row = habits.actions[key] || { attempts: 0, successes: 0, failures: 0, score: 0 };
  row.attempts += 1;
  if (result.success) row.successes += 1;
  else row.failures += 1;
  row.score = ((row.successes * 1.5) - (row.failures * 2));
  habits.actions[key] = row;
  habits.recent.push({ action, key, success: !!result.success, at: Date.now() });
  if (habits.recent.length > 200) habits.recent = habits.recent.slice(-200);
  saveState(state);
}

module.exports = { bucket, get, adjustment, record };
