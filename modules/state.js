'use strict';

const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'survival_state.json');

const DEFAULT = {
  version: 2,
  base: null,
  home: null,
  enchantRoomBuilt: false,
  hasFarm: false,
  farm: null,
  selfAwareness: null,
  longTermGoals: {},
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
  habits: { version: 1, actions: {}, recent: [] },
  awareness: { version: 1, capabilities: {}, currentThought: null, reflections: [], lastResearchAt: 0 },
  baseDesign: { palette: null, style: null, roomsPlanned: [], roomsBuilt: {} },
  storage: { version: 1, categoryChests: {}, lastSortAt: 0 },
  combat: { version: 1, kills: 0, retreats: 0, knockbackRecoveries: 0, lastThreatAt: 0 },
  mining: { version: 1, sessions: 0, oresMined: 0, lastSessionAt: 0 },
  knowledge: { version: 1, learnedTopics: {}, lastResearchAt: 0 },
  itemKnowledge: { version: 1, itemCount: 0, generatedAt: 0 },
  learnedBuilds: { last: null, history: [] },
  learnedFarms: { last: null, history: [] },
  acquisitionGraph: { version: 1, itemCount: 0, generatedAt: 0 },
  acquisitionLearning: { methods: {}, recent: [] },
  videoResearch: { last: null, history: [] }
};

function mergeDefaults(value) {
  const s = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT, ...s,
    memory: { ...DEFAULT.memory, ...(s.memory || {}) },
    experience: { ...DEFAULT.experience, ...(s.experience || {}), actions: { ...(DEFAULT.experience.actions || {}), ...((s.experience || {}).actions || {}) }, episodes: ((s.experience || {}).episodes || []), principles: { ...((s.experience || {}).principles || {}) } },
    habits: { ...DEFAULT.habits, ...(s.habits || {}), actions: { ...(DEFAULT.habits.actions || {}), ...((s.habits || {}).actions || {}) }, recent: ((s.habits || {}).recent || []) },
    awareness: { ...DEFAULT.awareness, ...(s.awareness || {}), capabilities: { ...(s.awareness.capabilities || {}) }, reflections: Array.isArray(s.awareness?.reflections) ? s.awareness.reflections.slice(-100) : [] },
    baseDesign: { ...DEFAULT.baseDesign, ...(s.baseDesign || {}), roomsBuilt: { ...(s.baseDesign?.roomsBuilt || {}) } },
    storage: { ...DEFAULT.storage, ...(s.storage || {}), categoryChests: { ...(s.storage?.categoryChests || {}) } },
    combat: { ...DEFAULT.combat, ...(s.combat || {}) },
    mining: { ...DEFAULT.mining, ...(s.mining || {}) },
    knowledge: { ...DEFAULT.knowledge, ...(s.knowledge || {}), learnedTopics: { ...(s.knowledge?.learnedTopics || {}) } },
    itemKnowledge: { ...DEFAULT.itemKnowledge, ...(s.itemKnowledge || {}) },
    learnedBuilds: { ...DEFAULT.learnedBuilds, ...(s.learnedBuilds || {}), history: Array.isArray(s.learnedBuilds?.history) ? s.learnedBuilds.history.slice(-40) : [] },
    learnedFarms: { ...DEFAULT.learnedFarms, ...(s.learnedFarms || {}), history: Array.isArray(s.learnedFarms?.history) ? s.learnedFarms.history.slice(-60) : [] },
    acquisitionGraph: { ...DEFAULT.acquisitionGraph, ...(s.acquisitionGraph || {}) },
    acquisitionLearning: { ...DEFAULT.acquisitionLearning, ...(s.acquisitionLearning || {}), methods: { ...(s.acquisitionLearning?.methods || {}) }, recent: Array.isArray(s.acquisitionLearning?.recent) ? s.acquisitionLearning.recent.slice(-100) : [] },
    videoResearch: { ...DEFAULT.videoResearch, ...(s.videoResearch || {}), history: Array.isArray(s.videoResearch?.history) ? s.videoResearch.history.slice(-60) : [] }
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
