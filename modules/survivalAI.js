'use strict';
// SURVIVAL AI - Botu gerçek bir oyuncu gibi hayatta tutmaya ve geliştirmeye
// çalışan öncelik tabanlı görev döngüsü.
//
// Öncelik sırası:
//   1) Acilse yiyecek bul (aç + envanterde yemek yok)
//   2) Ahşap alet yoksa -> odun topla -> ahşap alet üret
//   3) Taş alet yoksa -> taş topla -> taş alet üret
//   4) Demir alet/zırh yoksa -> maden ara (kömür+demir) -> erit -> üret
//   5) Elmas alet/zırh yoksa -> derin maden (elmas/lapis/altın/redstone) -> üret
//   6) Gizli üs kurulmadıysa -> kur
//   7) Büyü odası kurulmadıysa -> kitaplık + büyü masası kur
//   8) Eldeki iyi eşyaları büyüle
//   9) Bakım: fazlalıkları üste bırak, tekrar başa dön

const { log, countItem, sleep } = require('./utils');
const invUtil = require('./inventory');
const gathering = require('./gathering');
const baseBuilder = require('./baseBuilder');
const enchanting = require('./enchanting');
const { loadState, saveState } = require('./state');

function start(bot, mcData, config, addInterval) {
  const cfg = config.survivalAI || {};
  if (!cfg.enabled) return;

  // İsteğe bağlı yardımcı eklentiler (varsa yüklenir, yoksa sessizce atlanır).
  try {
    const armorManager = require('mineflayer-armor-manager');
    bot.loadPlugin(armorManager);
  } catch (e) {
    log('SurvivalAI', 'mineflayer-armor-manager bulunamadı (opsiyonel). "npm install mineflayer-armor-manager" ile ekleyebilirsin.');
  }
  try {
    const toolPlugin = require('mineflayer-tool').plugin;
    bot.loadPlugin(toolPlugin);
  } catch (e) {
    log('SurvivalAI', 'mineflayer-tool bulunamadı (opsiyonel). "npm install mineflayer-tool" ile ekleyebilirsin.');
  }

  let busy = false;

  log('SurvivalAI', 'Otonom hayatta kalma yapay zekası başlatıldı.');

  const tick = addInterval(async () => {
    if (!bot || !bot.entity || busy) return;
    busy = true;
    try {
      await runOneStep(bot, mcData, cfg);
      if (bot.armorManager) { try { bot.armorManager.equipAll(); } catch (e) { } }
    } catch (e) {
      log('SurvivalAI', `Adım hatası: ${e.message}`);
    } finally {
      busy = false;
    }
  }, cfg.interval || 4000);

  return tick;
}

async function runOneStep(bot, mcData, cfg) {
  const state = loadState();
  const gather = cfg.gather || {};
  const mining = cfg.mining || {};
  const base = cfg.base || {};
  const ench = cfg.enchanting || {};

  // 1) Acil açlık
  if (bot.food !== undefined && bot.food <= 6 && countItem(bot, i => i.name.includes('cooked') || i.name.includes('bread') || i.name.includes('apple')) === 0) {
    log('SurvivalAI', 'Görev: acil yiyecek arıyorum (hayvan avlama).');
    await gathering.huntNearbyAnimal(bot);
    return;
  }

  const tier = invUtil.currentToolTier(bot);

  // 2) Ahşap seviye
  if (!invUtil.hasFullToolSet(bot, 'wooden')) {
    if (countItem(bot, i => gathering.LOG_MATCH(i.name)) < (gather.woodTarget || 20)) {
      log('SurvivalAI', 'Görev: odun topluyorum.');
      await gathering.gatherWood(bot, mcData, gather.woodTarget || 20);
      return;
    }
    log('SurvivalAI', 'Görev: ahşap aletler üretiliyor.');
    await invUtil.craftToolTier(bot, mcData, 'wooden');
    return;
  }

  // 3) Taş seviye
  if (!invUtil.hasFullToolSet(bot, 'stone')) {
    if (countItem(bot, i => i.name === 'cobblestone' || i.name === 'cobbled_deepslate') < (gather.cobbleTarget || 32)) {
      log('SurvivalAI', 'Görev: taş topluyorum.');
      await gathering.mineStone(bot, mcData, gather.cobbleTarget || 32);
      return;
    }
    log('SurvivalAI', 'Görev: taş aletler üretiliyor.');
    await invUtil.craftToolTier(bot, mcData, 'stone');
    return;
  }

  // 4) Demir seviye (alet + zırh)
  if (!invUtil.hasFullToolSet(bot, 'iron') || !invUtil.hasFullArmorSet(bot, 'iron')) {
    const needIron = 12 - countItem(bot, 'iron_ingot') - countItem(bot, 'raw_iron');
    if (needIron > 0) {
      log('SurvivalAI', 'Görev: demir cevheri arıyorum.');
      await gathering.stripMineForOres(bot, mcData, gathering.ORE_GROUPS.iron.concat(gathering.ORE_GROUPS.coal), needIron + 8, mining.shaftYLevel || 40, 200);
      return;
    }
    if (countItem(bot, 'raw_iron') > 0) {
      log('SurvivalAI', 'Görev: demir eritiliyor.');
      await invUtil.smeltItems(bot, mcData, 'raw_iron', countItem(bot, 'raw_iron'));
      return;
    }
    log('SurvivalAI', 'Görev: demir alet/zırh üretiliyor.');
    await invUtil.craftToolTier(bot, mcData, 'iron');
    await invUtil.craftArmorTier(bot, mcData, 'iron');
    return;
  }

  // 5) Elmas seviye (alet + zırh) + lapis/altın/redstone toplama
  if (!invUtil.hasFullToolSet(bot, 'diamond') || !invUtil.hasFullArmorSet(bot, 'diamond')) {
    const needDiamond = 24 - countItem(bot, 'diamond');
    if (needDiamond > 0) {
      log('SurvivalAI', 'Görev: derin madende elmas/lapis arıyorum.');
      const oreList = [].concat(
        gathering.ORE_GROUPS.diamond,
        gathering.ORE_GROUPS.lapis,
        gathering.ORE_GROUPS.gold,
        gathering.ORE_GROUPS.redstone,
        gathering.ORE_GROUPS.iron,
        gathering.ORE_GROUPS.coal
      );
      await gathering.stripMineForOres(bot, mcData, oreList, needDiamond + 6, mining.shaftYLevel || -58, 300);
      return;
    }
    log('SurvivalAI', 'Görev: elmas alet/zırh üretiliyor.');
    await invUtil.craftToolTier(bot, mcData, 'diamond');
    await invUtil.craftArmorTier(bot, mcData, 'diamond');
    return;
  }

  // 6) Gizli üs
  if (base.enabled !== false && !state.base) {
    log('SurvivalAI', 'Görev: gizli yer altı üssü inşa ediliyor.');
    await baseBuilder.buildHiddenBase(bot, mcData, base);
    return;
  }

  // 7) Büyü odası
  if (ench.enabled !== false && !state.enchantRoomBuilt && state.base) {
    log('SurvivalAI', 'Görev: büyü odası ve kitaplıklar hazırlanıyor.');
    const { Vec3 } = require('./utils');
    await enchanting.buildEnchantRoom(bot, mcData, new Vec3(state.base.x, state.base.y, state.base.z), ench.bookshelfCount || 15);
    return;
  }

  // 8) Büyüleme
  if (ench.enabled !== false && state.enchantRoomBuilt) {
    const unenchanted = bot.inventory.items().some(i =>
      /^(iron|diamond)_(pickaxe|axe|shovel|sword|helmet|chestplate|leggings|boots)$/.test(i.name) &&
      (!i.enchants || i.enchants.length === 0)
    );
    if (unenchanted && countItem(bot, 'lapis_lazuli') >= 3) {
      log('SurvivalAI', 'Görev: eşyalar büyüleniyor.');
      await enchanting.enchantAllGear(bot, mcData);
      return;
    }
  }

  // 9) Bakım: fazla eşyayı üsse bırak
  if (state.base && countItem(bot, () => true) > 30) {
    log('SurvivalAI', 'Görev: envanter fazlalıkları üsse taşınıyor.');
    await baseBuilder.enterBase(bot, state.base);
    await baseBuilder.depositExtras(bot, ['pickaxe', 'axe', 'shovel', 'sword', 'helmet', 'chestplate', 'leggings', 'boots', 'diamond', 'food', 'beef', 'porkchop', 'chicken', 'mutton']);
    await baseBuilder.exitBase(bot, state.base);
    return;
  }

  // Yapacak acil bir şey yoksa normal AFK davranışlarına bırak.
}

module.exports = { start, runOneStep };
