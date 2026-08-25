'use strict';
// Kategorili sandık sistemi: blok sandığı, yemek sandığı, ekipman (set) sandığı,
// değerli eşya sandığı ve diğer her şey için bir "genel" sandık. Amaç, gerçek
// bir oyuncunun üssünde göreceğin türden düzenli bir depolama.

const { log, gotoPos, safePlace, findOneBlock, countItem, sleep, Vec3 } = require('./utils');
const { loadState, saveState } = require('./state');

const CATEGORIES = {
  blocks: {
    label: 'Blok Sandığı',
    match: (name) => /_log$|_planks$|_stem$|cobblestone|cobbled_deepslate|^stone$|^dirt$|^sand$|^gravel$|_bricks$|granite|diorite|andesite|deepslate|glass|wool|terracotta|concrete/.test(name)
  },
  food: {
    label: 'Yemek Sandığı',
    match: (name) => /cooked_|^bread$|^apple$|^carrot$|^potato$|^beetroot|melon|^egg$|^milk_bucket$|stew|^cake$|_seeds$/.test(name)
  },
  gear: {
    label: 'Ekipman Sandığı',
    match: (name) => /_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|_helmet$|_chestplate$|_leggings$|_boots$|shield|_bow$|arrow/.test(name)
  },
  valuables: {
    label: 'Değerli Eşya Sandığı',
    match: (name) => /^diamond$|^emerald$|^netherite/.test(name) || (/^enchanted_book$|_ingot$|^gold_nugget$|^lapis_lazuli$|^redstone$/.test(name))
  }
};
const DEFAULT_CATEGORY = { label: 'Genel Sandık', key: 'misc' };

function categorize(itemName) {
  for (const [key, def] of Object.entries(CATEGORIES)) {
    if (def.match(itemName)) return key;
  }
  return DEFAULT_CATEGORY.key;
}

// state.base.chestMap: { blocks: {x,y,z}, food: {x,y,z}, ... } - hangi sandığın
// hangi kategoriye ait olduğunu kalıcı olarak hatırlar.
function ensureChestMap(state) {
  if (!state.base) return null;
  state.base.chestMap = state.base.chestMap || {};
  return state.base.chestMap;
}

function storageAnchor(base) {
  if (base.rooms && base.rooms.storage) return new Vec3(base.rooms.storage.x, base.rooms.storage.y, base.rooms.storage.z);
  return new Vec3(base.x, base.y, base.z);
}

// Belirli bir kategori için sandık yoksa, depo odasında boş bir noktaya bir
// tane üretip yerleştirir ve state'e kaydeder.
async function ensureCategoryChest(bot, mcData, category) {
  const state = loadState();
  if (!state.base) return null;
  const chestMap = ensureChestMap(state);
  if (chestMap[category]) return chestMap[category];

  const inv = require('./inventory');
  if (!bot.inventory.items().some(i => i.name === 'chest')) {
    await inv.convertLogsToPlanks(bot, mcData);
    const table = findOneBlock(bot, ['crafting_table'], 8);
    if (table && countItem(bot, i => /_planks$/.test(i.name)) >= 8) {
      await inv.craftItemByName(bot, mcData, 'chest', 1, table);
    }
  }
  if (!bot.inventory.items().some(i => i.name === 'chest')) return null;

  const anchor = storageAnchor(state.base);
  const existingCount = Object.keys(chestMap).length;
  // Depo odasında sandıkları yan yana bir sıraya diz.
  const spot = anchor.offset(existingCount % 4, 0, Math.floor(existingCount / 4));
  const ref = bot.blockAt(spot.offset(0, -1, 0));
  try {
    if (bot.entity.position.distanceTo(spot) > 4) await gotoPos(bot, spot, 3, 15000);
    const placed = await safePlace(bot, 'chest', ref, new Vec3(0, 1, 0));
    if (!placed) return null;
    chestMap[category] = { x: spot.x, y: spot.y, z: spot.z };
    saveState(state);
    log('ChestSystem', `${(CATEGORIES[category] || DEFAULT_CATEGORY).label} kuruldu: (${spot.x}, ${spot.y}, ${spot.z})`);
    return chestMap[category];
  } catch (e) {
    log('ChestSystem', `Sandık yerleştirme hatası: ${e.message}`);
    return null;
  }
}

// Verilen kategorideki sandığa, envanterdeki o kategoriye ait eşyaları bırakır.
async function depositCategory(bot, category, keepNames) {
  const state = loadState();
  const chestMap = ensureChestMap(state);
  if (!chestMap || !chestMap[category]) return false;
  const pos = new Vec3(chestMap[category].x, chestMap[category].y, chestMap[category].z);
  const block = bot.blockAt(pos);
  if (!block || block.name !== 'chest') {
    // Sandık bir şekilde kayboldu/kırıldı, kaydı temizle ki yeniden kurulabilsin.
    delete chestMap[category];
    saveState(state);
    return false;
  }
  try {
    await gotoPos(bot, pos, 2, 10000);
    const chest = await bot.openContainer(block);
    for (const item of bot.inventory.items()) {
      if (keepNames && keepNames.some(n => item.name.includes(n))) continue;
      if (categorize(item.name) !== category) continue;
      try { await chest.deposit(item.type, null, item.count); } catch (e) { }
    }
    chest.close();
    return true;
  } catch (e) {
    log('ChestSystem', `${category} sandığına koyma hatası: ${e.message}`);
    return false;
  }
}

// Ana giriş noktası: aktif olarak kullanılan aletleri/zırhı üstünde tutarak
// geri kalan her şeyi doğru kategori sandığına dağıtır. Sandık yoksa (ve
// malzeme varsa) önce kurar.
async function sortInventory(bot, mcData, keepNames = []) {
  const state = loadState();
  if (!state.base) return false;

  const present = new Set(
    bot.inventory.items()
      .filter(i => !keepNames.some(n => i.name.includes(n)))
      .map(i => categorize(i.name))
  );

  let any = false;
  for (const category of present) {
    await ensureCategoryChest(bot, mcData, category);
    const ok = await depositCategory(bot, category, keepNames);
    if (ok) any = true;
    await sleep(150);
  }
  return any;
}

function report() {
  const state = loadState();
  const chestMap = (state.base && state.base.chestMap) || {};
  return Object.entries(chestMap).map(([category, pos]) => ({
    category,
    label: (CATEGORIES[category] || DEFAULT_CATEGORY).label,
    position: pos
  }));
}

module.exports = {
  CATEGORIES,
  categorize,
  ensureCategoryChest,
  depositCategory,
  sortInventory,
  report
};
