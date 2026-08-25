'use strict';
// Büyü masası odası + 15 kitaplıklı "max seviye (30)" halkası + büyü basma.
// NOT: Bu modül deneyseldir - mineflayer sürümüne göre küçük API farkları
// olabilir; hata durumunda konsola loglar ve botu çökertmeden devam eder.

const { log, gotoPos, gotoBlock, findOneBlock, safePlace, countItem, sleep, Vec3 } = require('./utils');
const inv = require('./inventory');
const { huntNearbyAnimal } = require('./gathering');

async function gatherPaperAndLeather(bot, mcData, wantBooks) {
  let attempts = 0;
  while (countItem(bot, 'leather') < wantBooks && attempts < 25) {
    attempts++;
    const ok = await huntNearbyAnimal(bot); // inek -> et + bazen deri
    if (!ok) await sleep(1000);
  }

  attempts = 0;
  while (countItem(bot, 'paper') < wantBooks * 3 && attempts < 40) {
    attempts++;
    const canePos = bot.findBlock({ matching: (b) => b && b.name === 'sugar_cane', maxDistance: 64 });
    if (!canePos) { await sleep(1000); continue; }
    const block = bot.blockAt(canePos);
    await gotoBlock(bot, block, 2);
    try { await bot.dig(block); } catch (e) { }
    await sleep(150);
  }

  const table = await inv.ensureCraftingTable(bot, mcData);
  if (table && countItem(bot, 'paper') >= 3 && countItem(bot, 'leather') >= 1) {
    const need = Math.min(wantBooks, Math.floor(countItem(bot, 'paper') / 3), countItem(bot, 'leather'));
    if (need > 0) await inv.craftItemByName(bot, mcData, 'book', need, table);
  }
}

async function gatherBookshelves(bot, mcData, count) {
  const have = countItem(bot, 'bookshelf');
  if (have >= count) return true;
  const wantBooks = (count - have) * 3;
  await gatherPaperAndLeather(bot, mcData, wantBooks);
  await inv.convertLogsToPlanks(bot, mcData);
  const table = await inv.ensureCraftingTable(bot, mcData);
  if (!table) return false;
  const need = count - have;
  if (countItem(bot, 'book') >= need * 3 && countItem(bot, i => /_planks$/.test(i.name)) >= need * 6) {
    await inv.craftItemByName(bot, mcData, 'bookshelf', need, table);
  }
  return countItem(bot, 'bookshelf') >= count;
}

// Masanın etrafında, Chebyshev mesafesi 2 olan 16 hücrelik halkadan
// bir tanesi giriş için boş bırakılıp 15 kitaplık dizilir (seviye 30 için standart dizilim).
function ringPositions(center) {
  const positions = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) === 2) {
        positions.push(center.offset(dx, 0, dz));
      }
    }
  }
  return positions; // 16 pozisyon
}

async function buildEnchantRoom(bot, mcData, roomCenter, bookshelfCount = 15) {
  const state = require('./state').loadState();
  if (state.enchantRoomBuilt) return true;

  if (countItem(bot, 'lapis_lazuli') < 1) log('Enchant', 'Lapis henüz yeterli değil, yine de oda kuruluyor.');

  let table = findOneBlock(bot, ['enchanting_table'], 8);
  if (!table) {
    if (!bot.inventory.items().some(i => i.name === 'enchanting_table')) {
      const craftTable = await inv.ensureCraftingTable(bot, mcData);
      // Büyü masası: elmas + obsidyen + kitap gerektirir - obsidyen genelde erişilemez,
      // bu yüzden yalnızca malzeme varsa üretilir; yoksa bu adım atlanır.
      if (craftTable && countItem(bot, 'diamond') >= 2 && countItem(bot, 'obsidian') >= 4 && countItem(bot, 'book') >= 1) {
        await inv.craftItemByName(bot, mcData, 'enchanting_table', 1, craftTable);
      }
    }
    if (bot.inventory.items().some(i => i.name === 'enchanting_table')) {
      const ref = bot.blockAt(roomCenter.offset(0, -1, 0));
      await safePlace(bot, 'enchanting_table', ref, new Vec3(0, 1, 0));
      await sleep(300);
      table = findOneBlock(bot, ['enchanting_table'], 6);
    }
  }
  if (!table) {
    log('Enchant', 'Büyü masası kurulamadı (muhtemelen obsidyen eksik). Bu özellik atlanıyor.');
    return false;
  }

  const ok = await gatherBookshelves(bot, mcData, bookshelfCount);
  if (!ok) {
    log('Enchant', 'Yeterli kitaplık toplanamadı, eldeki kadarıyla devam edilecek.');
  }

  const spots = ringPositions(table.position).slice(0, bookshelfCount + 1);
  spots.shift(); // biri giriş için boş kalsın
  for (const pos of spots) {
    if (countItem(bot, 'bookshelf') < 1) break;
    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!below) continue;
    await safePlace(bot, 'bookshelf', below, new Vec3(0, 1, 0));
    await sleep(150);
  }

  state.enchantRoomBuilt = true;
  require('./state').saveState(state);
  return true;
}

// Envanterdeki tüm üst düzey aletleri/zırhı, mümkün olan en güçlü seçenekle büyüler.
async function enchantAllGear(bot, mcData) {
  const table = findOneBlock(bot, ['enchanting_table'], 8);
  if (!table) return false;
  if (countItem(bot, 'lapis_lazuli') < 3) return false;
  if (!bot.experience || bot.experience.level < 3) return false;

  const targets = bot.inventory.items().filter(i =>
    /_pickaxe$|_axe$|_shovel$|_sword$|_helmet$|_chestplate$|_leggings$|_boots$/.test(i.name) &&
    /^(iron|diamond)_/.test(i.name)
  );

  for (const item of targets) {
    try {
      await gotoBlock(bot, table, 2);
      const window = await bot.openEnchantmentTable(table);
      await bot.equip(item, 'hand');
      await sleep(500);
      const choices = window.enchantments ? window.enchantments.filter(c => c) : [];
      if (choices.length === 0) { window.close(); continue; }
      // En güçlü (en yüksek seviye gereksinimli / en çok lapis isteyen) seçeneği al.
      let bestIdx = 0;
      for (let i = 1; i < choices.length; i++) {
        if (choices[i] && (!choices[bestIdx] || choices[i].level > choices[bestIdx].level)) bestIdx = i;
      }
      if (choices[bestIdx] && bot.experience.level >= choices[bestIdx].level) {
        await window.enchant(bestIdx);
        log('Enchant', `${item.name} büyülendi (seviye ${choices[bestIdx].level}).`);
        await sleep(500);
      }
      window.close();
    } catch (e) {
      log('Enchant', `Hata (${item.name}): ${e.message}`);
    }
  }
  return true;
}

module.exports = {
  gatherBookshelves,
  buildEnchantRoom,
  enchantAllGear
};
