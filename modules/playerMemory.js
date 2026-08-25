'use strict';

const { loadState, saveState } = require('./state');

function rememberPlayer(bot, username, event = 'seen') {
  if (!username || username === bot.username) return;
  const state = loadState();
  state.memory = state.memory || { events: [], locations: {}, players: {}, failures: {}, successes: {} };
  const p = state.memory.players[username] || {
    name: username, firstSeen: Date.now(), seenCount: 0,
    trust: 0, threat: 0, lastPosition: null, lastEvent: null
  };
  p.seenCount++;
  p.lastEvent = event;
  if (bot.players && bot.players[username] && bot.players[username].entity) {
    const pos = bot.players[username].entity.position;
    p.lastPosition = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  }
  if (event === 'attacked') p.threat = Math.min(100, p.threat + 25);
  if (event === 'helped') p.trust = Math.min(100, p.trust + 15);
  state.memory.players[username] = p;
  saveState(state);
}

function playerProfile(username) {
  const state = loadState();
  return state.memory && state.memory.players && state.memory.players[username] || null;
}

module.exports = { rememberPlayer, playerProfile };
