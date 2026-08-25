'use strict';

const { loadState, saveState } = require('./state');

function ensure(state) {
  state.habits = state.habits || { actions: {}, routines: {}, version: 1 };
  state.habits.actions = state.habits.actions || {};
  state.habits.routines = state.habits.routines || {};
  return state.habits;
}

function touchHabit(action, context, reward) {
  const state = loadState();
  const habits = ensure(state);
  const key = `${action}|${context || 'any'}`;
  const h = habits.actions[key] || { action, context: context || 'any', uses: 0, successes: 0, failures: 0, value: 0, lastAt: 0, streak: 0 };
  h.uses += 1;
  if (reward > 0) { h.successes += 1; h.streak = Math.max(0, h.streak) + 1; }
  else if (reward < 0) { h.failures += 1; h.streak = Math.min(0, h.streak) - 1; }
  h.value = h.value * 0.8 + reward * 0.2;
  h.lastAt = Date.now();
  habits.actions[key] = h;
  saveState(state);
  return h;
}

function preference(action, context) {
  const state = loadState();
  const habits = ensure(state);
  const exact = habits.actions[`${action}|${context || 'any'}`];
  const global = habits.actions[`${action}|any`];
  return (exact ? exact.value * 0.75 : 0) + (global ? global.value * 0.25 : 0);
}

// Raw habit entry (uses, streak, value) for a given action/context — used to
// detect "the bot has repeatedly failed at this" rather than just a soft bonus.
function getHabit(action, context) {
  const state = loadState();
  const habits = ensure(state);
  return habits.actions[`${action}|${context || 'any'}`] || null;
}

function registerRoutine(name, data = {}) {
  const state = loadState();
  const habits = ensure(state);
  const r = habits.routines[name] || { runs: 0, successes: 0, failures: 0, lastAt: 0 };
  r.runs += 1;
  if (data.success) r.successes += 1;
  if (data.failure) r.failures += 1;
  r.lastAt = Date.now();
  habits.routines[name] = r;
  saveState(state);
  return r;
}

module.exports = { touchHabit, preference, getHabit, registerRoutine };
