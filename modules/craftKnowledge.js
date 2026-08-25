'use strict';
/*
 * Craft Knowledge.
 *
 * Oyundaki sabit bir "tarif listesi" tutmak yerine, mineflayer'ın zaten
 * bildiği mcData tarif grafiğini kullanarak herhangi bir item için nasıl
 * üretileceğini kendisi çıkarır: gereken alt malzemeleri bulur, onları da
 * (gerekiyorsa) önce üretir, sonunda hedef eşyayı craftlar. Bilmediği bir
 * şeyi de bu sayede "öğrenebilir" - sabit kodlanmış bir tarif eklemeye
 * gerek kalmadan.
 */

const { log, gotoBlock, findOneBlock, countItem, sleep } = require('./utils');
const inv = require('./inventory');

const RAW_GATHER = {
  // İsim deseni -> hangi gathering fonksiyonuyla elde edilebileceği (best-effort).
  logLike: /_log$|_stem$/,
  stoneLike: /^(stone|cobblestone|cobbled_deepslate|andesite|diorite|granite)$/
};

// Bir eşya için mcData'dan bulunabilecek ilk tarifi döner (elde/masa fark etmez).
function findRecipe(bot, mcData, itemName, table) {
  const data = mcData.itemsByName[itemName];
  if (!data) return null;
  const recipes = bot.recipesFor(data.id, null, 1, table || null);
  if (recipes.length) return recipes[0];
  // Masa gerektiren bir tarif olabilir, masa varsa onunla dene.
  if (!table) {
    const nearTable = findOneBlock(bot, ['crafting_table'], 12);
    if (nearTable) {
      const withTable = bot.recipesFor(data.id, null, 1, bot.blockAt(nearTable));
      if (withTable.length) return withTable[0];
    }
  }
  return null;
}

// Bir tarifin gerektirdiği ham malzemeleri, envanterde eksik olanları
// listeler (miktarıyla birlikte).
function missingIngredients(bot, recipe, craftsNeeded) {
  if (!recipe.delta) return [];
  const missing = [];
  for (const d of recipe.delta) {
    if (d.count >= 0) continue; // sadece tüketilenler (negatif delta)
    const needed = Math.abs(d.count) * craftsNeeded;
    const have = countItem(bot, i => i.type === d.id);
    if (have < needed) missing.push({ id: d.id, needed: needed - have });
  }
  return missing;
}

// Ham malzemeyi elde etmeye çalışır: kendi envanterinde alt-craftlanabilir bir
// item ise onu recursive olarak craftlar, doğa taşı/odunuysa mevcut gathering
// modüllerini kullanır. Elde edemezse false döner ama üst süreci bozmaz.
async function tryProvideRawMaterial(bot, mcData, itemId, needed, opts = {}) {
  const data = mcData.items[itemId];
  if (!data) return false;
  const name = data.name;

  // Zaten alt-craft edilebilir bir şeyse (örn. stick, planks) önce onu dene.
  const subRecipe = findRecipe(bot, mcData, name);
  if (subRecipe) {
    const ok = await autoCraft(bot, mcData, name, needed, { depth: (opts.depth || 0) + 1 });
    if (ok) return true;
  }

  const gathering = require('./gathering');
  if (RAW_GATHER.logLike.test(name)) {
    await gathering.gatherWood(bot, mcData, needed + countItem(bot, i => RAW_GATHER.logLike.test(i.name)));
    return countItem(bot, i => RAW_GATHER.logLike.test(i.name)) >= needed;
  }
  if (RAW_GATHER.stoneLike.test(name)) {
    await gathering.mineStone(bot, mcData, needed + countItem(bot, i => i.name === 'cobblestone'));
    return countItem(bot, 'cobblestone') >= needed;
  }
  // Cevher ailelerinden biriyse strip-mine dener.
  for (const [ore, names] of Object.entries(gathering.ORE_GROUPS || {})) {
    if (names.some(n => name.includes(ore))) {
      await gathering.stripMineForOres(bot, mcData, names, needed, -40, 120);
      return true;
    }
  }
  return false;
}

// Belirli bir item'ı, gereken malzemeleri elden geldiğince tamamlayarak
// (alt-craft + ham madde toplama) üretmeye çalışır. Bulamadığı/üretemediği
// bir şey varsa denemeye devam etmez, false döner - ama exception fırlatıp
// bütün görev döngüsünü çökertmez.
async function autoCraft(bot, mcData, itemName, count = 1, opts = {}) {
  const depth = opts.depth || 0;
  if (depth > 4) return false; // sonsuz döngüye karşı güvenlik sınırı

  if (countItem(bot, itemName) >= count) return true;

  const table = findOneBlock(bot, ['crafting_table'], 12);
  const recipe = findRecipe(bot, mcData, itemName, table ? bot.blockAt(table) : null);
  if (!recipe) {
    log('CraftKnowledge', `"${itemName}" için bilinen bir tarif bulunamadı.`);
    return false;
  }

  const craftsNeeded = Math.max(1, Math.ceil(count / (recipe.result.count || 1)));
  const missing = missingIngredients(bot, recipe, craftsNeeded);
  for (const m of missing) {
    await tryProvideRawMaterial(bot, mcData, m.id, m.needed, { depth });
  }

  const stillMissing = missingIngredients(bot, recipe, craftsNeeded);
  if (stillMissing.length > 0) {
    log('CraftKnowledge', `"${itemName}" için malzeme tamamlanamadı, vazgeçiliyor.`);
    return false;
  }

  try {
    if (table) await gotoBlock(bot, bot.blockAt(table), 2);
    await bot.craft(recipe, craftsNeeded, table ? bot.blockAt(table) : null);
    await sleep(150);
    return countItem(bot, itemName) >= count;
  } catch (e) {
    log('CraftKnowledge', `"${itemName}" craftlanamadı: ${e.message}`);
    return false;
  }
}

// Bir item hakkında bot ne biliyor: tarif var mı, hangi malzemeler gerekiyor.
// Bilgi/farkındalık raporlaması için kullanılır.
function describeRecipe(bot, mcData, itemName) {
  const data = mcData.itemsByName[itemName];
  if (!data) return { known: false, itemName };
  const withoutTable = bot.recipesFor(data.id, null, 1, null);
  if (withoutTable.length) return { known: true, itemName, needsTable: false };
  const table = findOneBlock(bot, ['crafting_table'], 12);
  const withTable = table ? bot.recipesFor(data.id, null, 1, bot.blockAt(table)) : [];
  if (withTable.length) return { known: true, itemName, needsTable: true };
  return { known: false, itemName };
}

module.exports = {
  findRecipe,
  missingIngredients,
  autoCraft,
  describeRecipe
};
