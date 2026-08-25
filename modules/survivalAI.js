'use strict';

/*
 * Autonomous Survival Brain v2.
 * The old fixed priority chain is retained conceptually, but decisions are now
 * scored and remembered. Each action is deliberately small so a failed action
 * does not destroy the whole loop.
 */

const { log, countItem, sleep, findOneBlock, Vec3 } = require('./utils');
const inv = require('./inventory');
const gathering = require('./gathering');
const baseBuilder = require('./baseBuilder');
const enchanting = require('./enchanting');
const { loadState, saveState } = require('./state');
const brain = require('./decisionEngine');
const farming = require('./farming');
const selfAwareness = require('./selfAwareness');
const knowledge = require('./knowledgeEngine');
const acquisition = require('./acquisitionEngine');
const autonomousBuilder = require('./autonomousBuilder');
const miningAI = require('./miningAI');
const baseSystem = require('./baseSystem');

const { sleep: wait } = require('./utils');

function start(bot, mcData, config, addInterval) {
  const cfg = config.survivalAI || {};
  if (!cfg.enabled) return;

  try { bot.loadPlugin(require('mineflayer-armor-manager')); } catch (_) {}
  try { bot.loadPlugin(require('mineflayer-tool').plugin); } catch (_) {}

  let busy = false;
  let lastMoodAt = 0;
  let lastAction = '';
  let consecutiveFailures = 0;

  log('SurvivalAI', 'Self-contained survival brain active. Navigation is owned by Pathfinder.');

  // Build local item knowledge once. It never calls an external AI service.
  try {
    const state = loadState();
    if (!state.itemKnowledge?.generatedAt || Date.now() - state.itemKnowledge.generatedAt > 24 * 3600 * 1000) {
      const itemKnowledge = acquisition.buildItemKnowledge(mcData);
      state.itemKnowledge = { version: 3, itemCount: Object.keys(itemKnowledge).length, generatedAt: Date.now() };
      saveState(state);
      try {
        const db = knowledge.loadKnowledge();
        db.items = itemKnowledge;
        knowledge.saveKnowledge(db);
      } catch (_) {}
    }
  } catch (_) {}

  addInterval(async () => {
    if (!bot?.entity || busy) return;
    // Symmetric to combatAI's check: if combat is actively mid-engagement
    // right now, don't start a fresh long task and immediately fight it for
    // the pathfinder goal. Let the current combat tick resolve first.
    if (bot.__autonomyBusy) return;
    busy = true;
    bot.__autonomyBusy = true;

    try {
      const decisionCfg = cfg.decision || {};
      const goal = brain.chooseGoal(bot, cfg);
      selfAwareness.reflect(bot, mcData, {
        goal: goal.name,
        reason: goal.reason,
        plan: 'local-state -> choose -> act -> verify'
      });

      // Fast local decisions: no artificial thinking delay.
      if (decisionCfg.thinkDelay === true && decisionCfg.allowArtificialDelay === true) {
        const min = decisionCfg.thinkMinMs == null ? 0 : decisionCfg.thinkMinMs;
        const max = decisionCfg.thinkMaxMs == null ? min : decisionCfg.thinkMaxMs;
        await wait(min + Math.floor(Math.random() * Math.max(1, max - min + 1)));
      }

      if (decisionCfg.moodMessages && Date.now() - lastMoodAt > (decisionCfg.moodCooldownMs || 120000)) {
        const a = selfAwareness.assess(bot);
        if (a.danger && typeof bot.chat === 'function') {
          bot.chat(a.health <= 8 ? 'Geri çekilip toparlanıyorum.' : 'Yiyecek durumumu kontrol ediyorum.');
          lastMoodAt = Date.now();
        }
      }

      const before = brain.stateSnapshot(bot);
      const episode = brain.experience.beginEpisode(goal, before);
      const startedAt = Date.now();
      try {
        await runGoal(bot, mcData, cfg, goal);
        brain.experience.finishEpisode(episode, brain.stateSnapshot(bot), {
          success: true,
          durationMs: Date.now() - startedAt,
          action: goal.action,
          goal: goal.name
        });
        brain.rememberHabit(goal.action, before, { success: true });
        lastAction = goal.action;
        consecutiveFailures = 0;
      } catch (goalError) {
        brain.experience.finishEpisode(episode, brain.stateSnapshot(bot), {
          success: false,
          aborted: true,
          durationMs: Date.now() - startedAt,
          action: goal.action,
          goal: goal.name,
          error: goalError.message
        });
        brain.rememberHabit(goal.action, before, { success: false });
        brain.rememberFailure(goal.action || 'runtime', { message: goalError.message });
        consecutiveFailures++;
        lastAction = goal.action || 'runtime';
        log('SurvivalAI', `Task failed: ${goalError.message}`);
      }

      if (bot.armorManager) {
        try { await bot.armorManager.equipAll(); } catch (_) {}
      }
    } catch (e) {
      log('SurvivalAI', `Brain error: ${e.message}`);
    } finally {
      bot.__autonomyBusy = false;
      busy = false;
    }
  }, Math.max(350, cfg.interval || 450));
}

async function ensureBasicGear(bot, mcData, tier) {
  if (tier === 'wooden') {
    await gathering.gatherWood(bot, mcData, 12);
  }
  if (tier === 'stone') {
    await gathering.mineStone(bot, mcData, 24);
  }
  await inv.craftToolTier(bot, mcData, tier);
  brain.rememberSuccess(`craft-${tier}`);
}

async function buildOrFindHome(bot, mcData, cfg) {
  const state = loadState();
  if (state.base || state.home) return true;

  // Reuse the project's existing protected underground base builder, but treat
  // the result as the bot's permanent home. This keeps the implementation safe
  // and compatible with the current project.
  const base = await baseBuilder.buildHiddenBase(bot, mcData, cfg.base || {});
  if (base) {
    state.base = base;
    state.home = {
      x: base.x, y: base.y, z: base.z,
      type: 'underground-home',
      createdAt: Date.now(),
      reasons: ['safe', 'private', 'expandable']
    };
    saveState(state);
    brain.rememberSuccess('home-selected', { home: state.home });
    return true;
  }
  return false;
}

async function sleepIfPossible(bot) {
  const bed = findOneBlock(bot, ['white_bed','red_bed','black_bed','blue_bed','green_bed','yellow_bed','brown_bed','cyan_bed','gray_bed','light_blue_bed','light_gray_bed','lime_bed','magenta_bed','orange_bed','pink_bed','purple_bed'], 8);
  if (!bed || typeof bot.sleep !== 'function') return false;
  try {
    await bot.sleep(bed);
    brain.rememberSuccess('sleep');
    return true;
  } catch (_) { return false; }
}

async function deposit(bot, mcData, state, cfg) {
  if (!state.base) return false;
  try {
    await baseBuilder.enterBase(bot, state.base);
    await baseBuilder.depositExtras(bot, [
      'pickaxe','axe','shovel','sword','helmet','chestplate','leggings','boots',
      'diamond','iron','gold','redstone','lapis','coal','charcoal',
      'food','beef','porkchop','chicken','mutton','bread','carrot','potato',
      'cobblestone','stone','dirt','gravel','sand','wood','log','planks'
    ]);
    if ((cfg.storage || {}).organizeChests !== false) await baseBuilder.organizeChests(bot, mcData, (cfg.storage || {}).radius || 12);
    await baseBuilder.exitBase(bot, state.base);
    brain.rememberSuccess('storage');
    return true;
  } catch (e) {
    brain.rememberFailure('storage', { message: e.message });
    return false;
  }
}

async function craftProgression(bot, mcData) {
  const table = await inv.ensureCraftingTable(bot, mcData);
  if (!table) return false;

  await inv.convertLogsToPlanks(bot, mcData);
  await inv.ensureSticks(bot, mcData, 8);

  const tiers = ['wooden','stone','iron','diamond'];
  for (const tier of tiers) {
    if (inv.hasFullToolSet(bot, tier) && (tier === 'wooden' || inv.hasFullArmorSet(bot, tier))) continue;
    await inv.craftToolTier(bot, mcData, tier);
    if (tier === 'iron' || tier === 'diamond') await inv.craftArmorTier(bot, mcData, tier);
    return true;
  }
  return false;
}

async function runGoal(bot, mcData, cfg, goal) {
  const state = loadState();
  switch (goal.action) {
    case 'survive':
    case 'food':
    case 'food-stock':
      if (countItem(bot, i => /cooked_|bread|apple|carrot|potato|beetroot|beef|porkchop|chicken|mutton|rabbit|cod|salmon|kelp|sweet_berries/.test(i.name)) > 0) {
        try {
          const food = bot.inventory.items().find(i => /cooked_|bread|apple|carrot|potato|beetroot|beef|porkchop|chicken|mutton|rabbit|cod|salmon|kelp|sweet_berries/.test(i.name));
          await bot.equip(food, 'hand');
          if (bot.food < 18 && typeof bot.consume === 'function') await bot.consume();
          return;
        } catch (_) {}
      }
      await gathering.huntNearbyAnimal(bot);
      return;

    case 'tools':
      await ensureBasicGear(bot, mcData, 'wooden');
      await craftProgression(bot, mcData);
      if ((cfg.crafting || {}).generalRecipes) {
        const targets = ['torch', 'chest', 'bucket'];
        const chosen = targets.find(n => countItem(bot, n) < (n === 'torch' ? 16 : 1));
        if (chosen) {
          try { await inv.craftAnyItem(bot, mcData, chosen, chosen === 'torch' ? 16 : 1, { maxDepth: (cfg.crafting || {}).maxRecipeDepth || 5 }); } catch (_) {}
        }
      }
      return;

    case 'maintenance':
      await craftProgression(bot, mcData);
      return;

    case 'fuel':
      if (countItem(bot, 'coal') + countItem(bot, 'charcoal') < 12) {
        await gathering.stripMineForOres(bot, mcData, gathering.ORE_GROUPS.coal, 12, (cfg.mining || {}).shaftYLevel || -58, 120);
      }
      return;

    case 'iron':
    case 'mine-iron':
      await gathering.stripMineForOres(
        bot, mcData,
        [].concat(gathering.ORE_GROUPS.iron, gathering.ORE_GROUPS.coal),
        Math.max(8, 16 - countItem(bot, 'iron_ingot')),
        (cfg.mining || {}).shaftYLevel || -40, 180
      );
      if (countItem(bot, 'raw_iron') > 0) await inv.smeltItems(bot, mcData, 'raw_iron', countItem(bot, 'raw_iron'));
      await inv.craftToolTier(bot, mcData, 'iron');
      await inv.craftArmorTier(bot, mcData, 'iron');
      return;

    case 'mine':
    case 'progress':
      if ((cfg.mining || {}).branchMining !== false) {
        const result = await miningAI.branchMine(bot, mcData, {
          targetY: (cfg.mining || {}).shaftYLevel || -58,
          maxSteps: (cfg.mining || {}).maxSteps || 320,
          targetCount: Math.max(6, (cfg.mining || {}).targetCount || 16),
          torchInterval: (cfg.mining || {}).torchInterval || 8,
          scanRadius: (cfg.mining || {}).scanRadius || 20,
          avoidLavaRadius: (cfg.mining || {}).avoidLavaRadius || 3,
          preferHighValue: (cfg.mining || {}).preferHighValue !== false,
          includeIron: (cfg.mining || {}).includeIron !== false,
          includeCoal: (cfg.mining || {}).includeCoal !== false,
          ores: [].concat(gathering.ORE_GROUPS.diamond, gathering.ORE_GROUPS.lapis, gathering.ORE_GROUPS.gold, gathering.ORE_GROUPS.redstone)
        });
        const st = loadState();
        st.mining = st.mining || { version: 1, sessions: 0, oresMined: 0, lastSessionAt: 0 };
        st.mining.sessions = (st.mining.sessions || 0) + 1;
        st.mining.oresMined = (st.mining.oresMined || 0) + (result.mined || 0);
        st.mining.lastSessionAt = Date.now();
        saveState(st);
      } else {
        await gathering.stripMineForOres(
          bot, mcData,
          [].concat(gathering.ORE_GROUPS.diamond, gathering.ORE_GROUPS.lapis, gathering.ORE_GROUPS.gold, gathering.ORE_GROUPS.redstone),
          Math.max(6, 12 - countItem(bot, 'diamond')),
          (cfg.mining || {}).shaftYLevel || -58, 220
        );
      }
      await inv.craftToolTier(bot, mcData, 'diamond');
      await inv.craftArmorTier(bot, mcData, 'diamond');
      return;

    case 'learned-build':
      await autonomousBuilder.autonomousBuildCycle(bot, mcData, {
        ...(cfg.learningBuilds || {}),
        knowledge: cfg.knowledge || {},
        base: cfg.base || {},
        farming: cfg.farming || {},
        storage: cfg.storage || {}
      });
      return;

    case 'research':
      log('SurvivalAI', 'Research goal disabled: bot is fully self-contained.');
      return;

    case 'farming':
      await farming.runFarmCycle(bot, mcData, cfg.farming || {});
      return;

    case 'home':
    case 'base':
      if (state.base) {
        const now = bot.time ? bot.time.timeOfDay : 0;
        if (now > 12500 && now < 23500 && await sleepIfPossible(bot)) return;
        await baseBuilder.buildRooms(bot, mcData, state.base, cfg.base || {});
        await baseBuilder.enterBase(bot, state.base);
        return;
      }
      await baseSystem.ensureBaseAndStorage(bot, mcData, cfg);
      return;

    case 'find-home':
      await baseSystem.ensureBaseAndStorage(bot, mcData, cfg);
      return;

    case 'storage':
      await deposit(bot, mcData, state, cfg);
      return;

    case 'base-maintenance':
      await baseSystem.ensureBaseAndStorage(bot, mcData, cfg);
      return;

    case 'enchant':
      if (!state.enchantRoomBuilt) {
        const cfgEnch = cfg.enchanting || {};
        await enchanting.buildEnchantRoom(bot, mcData, state.base ? new Vec3(state.base.x, state.base.y, state.base.z) : bot.entity.position, cfgEnch.bookshelfCount || 15);
      }
      await enchanting.enchantAllGear(bot, mcData);
      return;

    case 'wood':
      await gathering.gatherWood(bot, mcData, (cfg.gather || {}).woodTarget || 20);
      await inv.convertLogsToPlanks(bot, mcData);
      return;

    case 'explore':
      // Prefer nearby meaningful blocks over blind wandering.
      await gathering.gatherWood(bot, mcData, 6);
      return;

    default:
      await craftProgression(bot, mcData);
  }
}

async function runOneStep(bot, mcData, cfg) {
  const goal = brain.chooseGoal(bot, cfg);
  return runGoal(bot, mcData, cfg, goal);
}

module.exports = { start, runOneStep };
