'use strict';

/*
 * Autonomous Survival Brain v2.
 * The old fixed priority chain is retained conceptually, but decisions are now
 * scored and remembered. Each action is deliberately small so a failed action
 * does not destroy the whole loop.
 */

const { log, countItem, sleep, findOneBlock } = require('./utils');
const inv = require('./inventory');
const gathering = require('./gathering');
const baseBuilder = require('./baseBuilder');
const enchanting = require('./enchanting');
const farming = require('./farming');
const chestSystem = require('./chestSystem');
const selfAwareness = require('./selfAwareness');
const { loadState, saveState } = require('./state');
const brain = require('./decisionEngine');
const planner = require('./adaptivePlanner');
const habits = require('./habitEngine');
const goalManager = require('./goalManager');

function start(bot, mcData, config, addInterval) {
  const cfg = config.survivalAI || {};
  if (!cfg.enabled) return;

  try {
    const armorManager = require('mineflayer-armor-manager');
    bot.loadPlugin(armorManager);
  } catch (_) {}
  try {
    const toolPlugin = require('mineflayer-tool').plugin;
    bot.loadPlugin(toolPlugin);
  } catch (_) {}

  let busy = false;
  let currentEpisode = null;
  let lastMoodChatAt = 0;
  const autonomyCfg = cfg.autonomy || {};
  log('SurvivalAI', 'Survival Brain v2 başlatıldı (otonom mod).');
  log('SurvivalAI', `Elindeki yetenekler:\n${selfAwareness.report()}`);

  // Botun kendi durumuna dair kısa bir farkındalık özeti - felsefi bir "bilinç"
  // iddiası değil, sahip olduğu sistemlerin şu anki durumunun periyodik raporu.
  addInterval(() => {
    if (!bot || !bot.entity) return;
    try {
      const self = selfAwareness.describeSelf(bot, cfg);
      log('Awareness', self.status.join(' | '));
    } catch (_) {}
  }, 30 * 60 * 1000);

  // Optional, low-frequency chat line reflecting the bot's current situation.
  // Off by default (settings.json -> survivalAI.autonomy.moodChat) so it never
  // spams chat; when on, it only speaks occasionally and never during danger
  // in a way that would distract from handling it.
  function moodLine(snap) {
    if (snap.health <= 8) return 'canım gerçekten azaldı, dikkatli olmam lazım.';
    if (snap.food <= 6) return 'acıktım, bir şeyler bulmam gerek.';
    const night = snap.timeOfDay > 12500 && snap.timeOfDay < 23500;
    if (night) return 'gece oldu, temkinli davranıyorum.';
    if (snap.emptySlots <= 2) return 'envanterim doldu, üsse dönüp boşaltmalıyım.';
    return null;
  }

  function maybeMoodChat(bot, autonomyCfg, snap) {
    if (!autonomyCfg.moodChat) return;
    const now = Date.now();
    if (now - lastMoodChatAt < 5 * 60 * 1000) return;
    if (Math.random() >= (autonomyCfg.moodChatChance || 0)) return;
    const line = moodLine(snap);
    if (!line) return;
    try { bot.chat(line); } catch (_) {}
    lastMoodChatAt = now;
  }

  return addInterval(async () => {
    if (!bot || !bot.entity || busy) return;
    busy = true;
    try {
      const goal = brain.chooseGoal(bot, cfg);

      // A short "thinking" pause before acting — a real player doesn't react
      // instantly the moment a decision forms, they hesitate for a beat.
      const [minDelay, maxDelay] = autonomyCfg.thinkDelayMs || [0, 0];
      if (maxDelay > 0) {
        await sleep(minDelay + Math.floor(Math.random() * Math.max(1, maxDelay - minDelay)));
      }
      if (!bot || !bot.entity) { busy = false; return; }

      if (goal.imperfectPick) {
        log('SurvivalAI', `"${goal.name}" seçildi (en iyisi değil ama olsun) — ${goal.reason}`);
      } else if (goal.avoidedMistake) {
        log('SurvivalAI', `"${goal.name}" öğrenilmiş bir hatadan kaçınarak seçildi.`);
      }

      maybeMoodChat(bot, autonomyCfg, brain.stateSnapshot(bot));

      const before = brain.stateSnapshot(bot);
      currentEpisode = brain.experience.beginEpisode(goal, before);
      const startedAt = Date.now();
      try {
        await runGoal(bot, mcData, cfg, goal);
        const after = brain.stateSnapshot(bot);
        const learned = brain.experience.finishEpisode(currentEpisode, after, {
          success: true,
          durationMs: Date.now() - startedAt,
          action: goal.action,
          goal: goal.name
        });
        planner.updateFromOutcome(goal, learned || { success: true }, brain.experience.contextKey(after));
        habits.touchHabit(goal.action || goal.name, brain.experience.contextKey(before), learned ? learned.reward : 5);
        if (goal.intentGoal) {
          const p = Math.min(1, (loadState().goals?.active?.[goal.intentGoal]?.progress || 0) + 0.08);
          goalManager.updateGoal(goal.intentGoal, { progress: p, attempts: ((loadState().goals?.active?.[goal.intentGoal]?.attempts) || 0) + 1 });
        }
      } catch (goalError) {
        const after = brain.stateSnapshot(bot);
        const learned = brain.experience.finishEpisode(currentEpisode, after, {
          success: false,
          aborted: true,
          durationMs: Date.now() - startedAt,
          action: goal.action,
          goal: goal.name,
          error: goalError.message
        });
        planner.updateFromOutcome(goal, learned || { success: false }, brain.experience.contextKey(after));
        habits.touchHabit(goal.action || goal.name, brain.experience.contextKey(before), learned ? learned.reward : -5);
        if (goal.name) brain.rememberFailure(`goal:${goal.name}`, { error: goalError.message });
        throw goalError;
      } finally {
        currentEpisode = null;
      }
      if (bot.armorManager) {
        try { await bot.armorManager.equipAll(); } catch (_) {}
      }
    } catch (e) {
      log('SurvivalAI', `Görev hatası: ${e.message}`);
      brain.rememberFailure('runtime', { message: e.message });
    } finally {
      busy = false;
      // Review long-term goals periodically, without interrupting the current task.
      try { goalManager.deriveProgress(bot, brain.stateSnapshot(bot)); } catch (_) {}
    }
  }, cfg.interval || 4000);
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

async function deposit(bot, mcData, state) {
  if (!state.base) return false;
  const keepNames = [
    'pickaxe', 'axe', 'shovel', 'sword', 'hoe', 'helmet', 'chestplate', 'leggings', 'boots'
  ];
  try {
    await baseBuilder.enterBase(bot, state.base);
    // Kategori sandık sistemi kurulmuşsa (üste depo odası varsa) her eşyayı
    // kendi sandığına dağıt; yoksa eski tek-sandık davranışına geri dön.
    const sorted = await chestSystem.sortInventory(bot, mcData, keepNames);
    if (!sorted) {
      await baseBuilder.depositExtras(bot, [
        ...keepNames,
        'diamond', 'iron', 'gold', 'redstone', 'lapis', 'coal', 'charcoal',
        'food', 'beef', 'porkchop', 'chicken', 'mutton', 'bread', 'carrot', 'potato',
        'cobblestone', 'stone', 'dirt', 'gravel', 'sand', 'wood', 'log', 'planks'
      ]);
    }
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
      if (countItem(bot, i => /cooked_|bread|apple|carrot|potato|beetroot/.test(i.name)) > 0) {
        try {
          const food = bot.inventory.items().find(i => /cooked_|bread|apple|carrot|potato|beetroot/.test(i.name));
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
      await gathering.stripMineForOres(
        bot, mcData,
        [].concat(gathering.ORE_GROUPS.diamond, gathering.ORE_GROUPS.lapis, gathering.ORE_GROUPS.gold, gathering.ORE_GROUPS.redstone),
        Math.max(6, 12 - countItem(bot, 'diamond')),
        (cfg.mining || {}).shaftYLevel || -58, 220
      );
      await inv.craftToolTier(bot, mcData, 'diamond');
      await inv.craftArmorTier(bot, mcData, 'diamond');
      return;

    case 'home':
      if (state.base) {
        const now = bot.time ? bot.time.timeOfDay : 0;
        if (now > 12500 && now < 23500 && await sleepIfPossible(bot)) return;
        await baseBuilder.enterBase(bot, state.base);
        return;
      }
      await buildOrFindHome(bot, mcData, cfg);
      return;

    case 'find-home':
      await buildOrFindHome(bot, mcData, cfg);
      return;

    case 'storage':
      await deposit(bot, mcData, state);
      return;

    case 'enchant':
      if (!state.enchantRoomBuilt) {
        const cfgEnch = cfg.enchanting || {};
        await enchanting.buildEnchantRoom(bot, mcData, state.base ? require('./utils').Vec3(state.base.x, state.base.y, state.base.z) : bot.entity.position, cfgEnch.bookshelfCount || 15);
      }
      await enchanting.enchantAllGear(bot, mcData);
      return;

    case 'wood':
      await gathering.gatherWood(bot, mcData, (cfg.gather || {}).woodTarget || 20);
      await inv.convertLogsToPlanks(bot, mcData);
      return;

    case 'farm': {
      const result = await farming.runFarmCycle(bot, mcData, cfg.farming || {});
      if (result && result.hasFarm) {
        const s = loadState();
        if (!s.hasFarm) { s.hasFarm = true; saveState(s); }
        brain.rememberSuccess('farm-established');
      }
      return;
    }

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
