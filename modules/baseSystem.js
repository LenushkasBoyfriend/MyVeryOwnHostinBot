'use strict';

const { loadState, saveState } = require('./state');
const baseBuilder = require('./baseBuilder');
const { log } = require('./utils');

async function ensureBaseAndStorage(bot, mcData, cfg = {}) {
  const state = loadState();
  const baseCfg = cfg.base || {};
  if (baseCfg.enabled === false) return { ok: false, reason: 'base-disabled' };

  try {
    if (!state.base) {
      const base = await baseBuilder.buildHiddenBase(bot, mcData, baseCfg);
      if (!base) return { ok: false, reason: 'base-build-failed' };
      state.base = base;
      state.home = { x: base.x, y: base.y, z: base.z, type: 'autonomous-base', createdAt: Date.now() };
      saveState(state);
    } else if (baseCfg.buildRooms !== false) {
      await baseBuilder.buildRooms(bot, mcData, state.base, baseCfg);
    }

    if (state.base && (cfg.storage?.enabled !== false)) {
      await baseBuilder.enterBase(bot, state.base);
      await baseBuilder.ensureCategoryChests(bot, mcData, state.base, cfg.storage?.categories || [
        'food','ores','building','tools','farming','redstone','blocks','misc'
      ]);
      if (cfg.storage?.organizeChests !== false) {
        await baseBuilder.organizeChests(bot, mcData, cfg.storage?.radius || 12);
      }
      await baseBuilder.exitBase(bot, state.base);
      const next = loadState();
      next.storage = next.storage || {};
      next.storage.lastSortAt = Date.now();
      saveState(next);
    }
    return { ok: true, base: loadState().base };
  } catch (e) {
    log('BaseSystem', `Döngü hatası: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

module.exports = { ensureBaseAndStorage };
