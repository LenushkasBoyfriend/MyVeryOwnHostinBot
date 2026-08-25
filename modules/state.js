'use strict';

const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'survival_state.json');

const DEFAULT = {
  version: 5,
  base: null,
  home: null,
  enchantRoomBuilt: false,
  lapisCollected: 0,
  lastDecision: null,
  memory: {
    events: [],
    locations: {},
    players: {},
    failures: {},
    successes: {}
  },
  experience: {
    version: 1,
    actions: {},
    episodes: [],
    principles: {}
  },
  goals: { active: {}, history: [], lastReview: 0 },
  habits: { actions: {}, routines: {}, version: 1 },
  planner: { strategy: 'balanced', strategies: {}, switches: [], lastSwitchAt: 0 },
  knowledge: { version: 1, sources: {}, topics: {}, techniques: {}, claims: {}, experiments: [], queue: [], lastLearnAt: 0, lastSearchAt: 0 }
};

function mergeDefaults(value) {
  const s = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT, ...s,
    memory: { ...DEFAULT.memory, ...(s.memory || {}) },
    experience: { ...DEFAULT.experience, ...(s.experience || {}), actions: { ...(DEFAULT.experience.actions || {}), ...((s.experience || {}).actions || {}) }, episodes: ((s.experience || {}).episodes || []), principles: { ...((s.experience || {}).principles || {}) } },
    knowledge: { ...DEFAULT.knowledge, ...(s.knowledge || {}), sources: { ...(DEFAULT.knowledge.sources || {}), ...((s.knowledge || {}).sources || {}) }, topics: { ...(DEFAULT.knowledge.topics || {}), ...((s.knowledge || {}).topics || {}) }, techniques: { ...(DEFAULT.knowledge.techniques || {}), ...((s.knowledge || {}).techniques || {}) }, claims: { ...(DEFAULT.knowledge.claims || {}), ...((s.knowledge || {}).claims || {}) }, experiments: ((s.knowledge || {}).experiments || []), queue: ((s.knowledge || {}).queue || []) }
  };
}
function loadState() {
  try {
    if (fs.existsSync(FILE)) return mergeDefaults(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) { console.log(`[State] Okuma hatası: ${e.message}`); }
  return mergeDefaults({});
}
function saveState(state) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(mergeDefaults(state), null, 2));
  } catch (e) { console.log(`[State] Yazma hatası: ${e.message}`); }
}
module.exports = { loadState, saveState };
