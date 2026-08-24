'use strict';
// Yer altında, rastgele bir konumda, gizli bir üs inşa eder ve
// giriş tünelini arkadan kapatarak (aynı blok tipleriyle) izleri gizler.

const { log, gotoPos, safeDig, safePlace, countItem, sleep, randInt, Vec3 } = require('./utils');
const { loadState, saveState } = require('./state');

// Bir bloğu kazar ve tipini (ileride aynısını geri koymak için) kaydeder.
async function digAndRecord(bot, pos, record) {
  const block = bot.blockAt(pos);
  if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'water' || block.name === 'lava') {
    if (block) record.push({ x: pos.x, y: pos.y, z: pos.z, blockName: block.name });
    return true;
  }
  const originalName = block.name;
  const ok = await safeDig(bot, block);
  if (ok) record.push({ x: pos.x, y: pos.y, z: pos.z, blockName: originalName });
  return ok;
}

// items envanterinde blockName'e en yakın eşleşen, yerleştirilebilir bir item bulur.
function findPlaceableFor(bot, blockName) {
  const exact = bot.inventory.items().find(i => i.name === blockName);
  if (exact) return exact.name;
  // Doğal blok ailelerine göre makul bir alternatif seç.
  const fallbackFamilies = [
    ['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'cobbled_deepslate', 'deepslate'],
    ['dirt', 'coarse_dirt', 'podzol'],
    ['grass_block', 'dirt']
  ];
  for (const family of fallbackFamilies) {
    if (family.includes(blockName)) {
      const alt = family.find(n => bot.inventory.items().some(i => i.name === n));
      if (alt) return alt;
    }
  }
  // Son çare: envanterdeki herhangi bir taş/toprak türevi.
  const any = bot.inventory.items().find(i => /stone|dirt|cobble|deepslate|granite|andesite|diorite/.test(i.name));
  return any ? any.name : null;
}

// Kazılan bir bloğu (kayıttaki tipe olabildiğince yakın malzemeyle) geri kapatır.
async function sealPosition(bot, entry) {
  if (!entry || entry.blockName === 'air' || entry.blockName === 'cave_air') return true;
  const placeName = findPlaceableFor(bot, entry.blockName);
  if (!placeName) return false;
  const target = new Vec3(entry.x, entry.y, entry.z);
  // Yerleştirmek için komşu (dolu) bir blok bulalım.
  const neighbors = [
    target.offset(0, -1, 0), target.offset(0, 1, 0),
    target.offset(1, 0, 0), target.offset(-1, 0, 0),
    target.offset(0, 0, 1), target.offset(0, 0, -1)
  ];
  for (const n of neighbors) {
    const nb = bot.blockAt(n);
    if (nb && nb.name !== 'air' && nb.name !== 'cave_air' && nb.boundingBox === 'block') {
      const face = target.minus(n);
      if (bot.entity.position.distanceTo(target) > 4.2) {
        await gotoPos(bot, target, 3, 8000);
      }
      const ok = await safePlace(bot, placeName, nb, face);
      if (ok) return true;
    }
  }
  return false;
}

// Rastgele bir üs hedefi seçer: mevcut konumdan searchRadius kadar uzakta bir (x,z)
// ve yüzeyin altında depthBelowSurface kadar derin bir y.
function pickBaseTarget(bot, config) {
  const [minR, maxR] = config.searchRadius || [60, 150];
  const [minD, maxD] = config.depthBelowSurface || [15, 25];
  const angle = Math.random() * Math.PI * 2;
  const dist = randInt(minR, maxR);
  const origin = bot.entity.position;
  const x = Math.floor(origin.x + Math.cos(angle) * dist);
  const z = Math.floor(origin.z + Math.sin(angle) * dist);
  return { x, z, depth: randInt(minD, maxD) };
}

// Belirli bir (x,z)'ye yürür (dijital patika, kazma yok - sadece normal yürüyüş).
async function walkToSurfaceXZ(bot, x, z) {
  const target = bot.entity.position.clone ? bot.entity.position.clone() : bot.entity.position;
  return gotoPos(bot, new Vec3(x, bot.entity.position.y, z), 3, 60000);
}

// Dikey bir şaft kazar, geçilen her bloğu kaydeder.
async function digShaftDown(bot, targetY, shaftRecord) {
  let guard = 0;
  while (bot.entity.position.y > targetY && guard < 200) {
    guard++;
    const feet = Math.floor(bot.entity.position.y);
    const belowPos = new Vec3(Math.floor(bot.entity.position.x), feet - 1, Math.floor(bot.entity.position.z));
    const feetPos = new Vec3(Math.floor(bot.entity.position.x), feet, Math.floor(bot.entity.position.z));
    await digAndRecord(bot, feetPos, shaftRecord);
    await digAndRecord(bot, belowPos, shaftRecord);
    await gotoPos(bot, belowPos, 0, 4000);
    await sleep(120);
  }
}

// WxHxL boyutunda bir oda oyar (girişin altında). Blokları kaydetmez -
// oda kalıcı olarak boş kalacak (üssün içi).
async function carveRoom(bot, center, size) {
  const { w, h, l } = size;
  const hw = Math.floor(w / 2), hl = Math.floor(l / 2);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = -hw; dx <= hw; dx++) {
      for (let dz = -hl; dz <= hl; dz++) {
        const pos = center.offset(dx, dy, dz);
        const block = bot.blockAt(pos);
        if (block && block.name !== 'air' && block.name !== 'cave_air') {
          await safeDig(bot, block);
        }
      }
    }
    await sleep(50);
  }
}

async function placeFurnitureInBase(bot, mcData, center) {
  const inv = require('./inventory');
  const tablePos = center.offset(1, 0, -1);
  const refT = bot.blockAt(tablePos.offset(0, -1, 0));
  if (bot.inventory.items().some(i => i.name === 'crafting_table')) {
    await safePlace(bot, 'crafting_table', refT, new Vec3(0, 1, 0));
  }
  const furnacePos = center.offset(-1, 0, -1);
  const refF = bot.blockAt(furnacePos.offset(0, -1, 0));
  if (bot.inventory.items().some(i => i.name === 'furnace')) {
    await safePlace(bot, 'furnace', refF, new Vec3(0, 1, 0));
  }
  // Sandık yoksa ve yeterli tahtamız varsa üretip koyalım.
  if (!bot.inventory.items().some(i => i.name === 'chest')) {
    await inv.convertLogsToPlanks(bot, mcData);
    const table = require('./utils').findOneBlock(bot, ['crafting_table'], 6);
    if (table && countItem(bot, i => /_planks$/.test(i.name)) >= 8) {
      await inv.craftItemByName(bot, mcData, 'chest', 1, table);
    }
  }
  if (bot.inventory.items().some(i => i.name === 'chest')) {
    const chestPos = center.offset(0, 0, -1);
    const refC = bot.blockAt(chestPos.offset(0, -1, 0));
    await safePlace(bot, 'chest', refC, new Vec3(0, 1, 0));
  }
}

// Fazla eşyaları üssün sandığına bırakır (aletleri/zırhı üstünde tutar).
async function depositExtras(bot, keepNames) {
  const chestPos = require('./utils').findOneBlock(bot, ['chest'], 8);
  if (!chestPos) return false;
  try {
    await gotoPos(bot, chestPos.position, 2, 8000);
    const chest = await bot.openContainer(bot.blockAt(chestPos.position));
    for (const item of bot.inventory.items()) {
      if (keepNames.some(n => item.name.includes(n))) continue;
      try { await chest.deposit(item.type, null, item.count); } catch (e) { }
    }
    chest.close();
    return true;
  } catch (e) {
    log('Base', `Sandığa koyma hatası: ${e.message}`);
    return false;
  }
}

// Ana fonksiyon: gizli üssü inşa eder (yoksa), state dosyasına kaydeder.
async function buildHiddenBase(bot, mcData, config) {
  const state = loadState();
  if (state.base) return state.base; // zaten var

  log('Base', 'Gizli üs için rastgele konum belirleniyor...');
  const targetInfo = pickBaseTarget(bot, config);
  await walkToSurfaceXZ(bot, targetInfo.x, targetInfo.z);

  const surfaceY = Math.floor(bot.entity.position.y);
  const targetY = surfaceY - targetInfo.depth;

  const shaftRecord = [];
  const entrancePos = { x: Math.floor(bot.entity.position.x), y: surfaceY, z: Math.floor(bot.entity.position.z) };

  await digShaftDown(bot, targetY, shaftRecord);

  const roomCenter = bot.entity.position.floored().offset(0, 0, 0);
  await carveRoom(bot, roomCenter, config.roomSize || { w: 5, h: 4, l: 5 });
  await placeFurnitureInBase(bot, mcData, roomCenter);

  // Şaftı yukarıdan aşağıya doğru geldiğimiz sırayı ters çevirerek kapat
  // (en derin blok en son kapanır, giriş en üstte açık bırakılır - o da mühürlenir).
  log('Base', 'Giriş tüneli mühürleniyor (kamuflaj)...');
  const toSeal = shaftRecord.slice().reverse();
  const entranceEntry = toSeal.shift(); // en üstteki (giriş) bloğu ayrı tutulur, en son o kapatılır
  for (const entry of toSeal) {
    await sealPosition(bot, entry);
    await sleep(80);
  }

  // Bota önce yukarı çıkması, sonra en üst girişi de kapatması gerekir.
  await gotoPos(bot, new Vec3(entrancePos.x, entrancePos.y, entrancePos.z), 1, 15000);
  if (entranceEntry) await sealPosition(bot, entranceEntry);

  const base = {
    x: roomCenter.x, y: roomCenter.y, z: roomCenter.z,
    entrance: entranceEntry ? { x: entranceEntry.x, y: entranceEntry.y, z: entranceEntry.z, blockName: entranceEntry.blockName } : entrancePos,
    shaftPath: shaftRecord
  };
  state.base = base;
  saveState(state);
  log('Base', `Gizli üs tamamlandı: (${base.x}, ${base.y}, ${base.z}). Giriş: (${base.entrance.x}, ${base.entrance.y}, ${base.entrance.z})`);
  return base;
}

// Giriş bloğunu kazıp içeri girer, sonra arkasından tekrar kapatır.
async function enterBase(bot, base) {
  if (!base || !base.entrance) return false;
  const entPos = new Vec3(base.entrance.x, base.entrance.y, base.entrance.z);
  await gotoPos(bot, entPos, 2, 30000);
  const block = bot.blockAt(entPos);
  if (block && block.name !== 'air' && block.name !== 'cave_air') {
    await safeDig(bot, block);
  }
  await gotoPos(bot, new Vec3(base.x, base.y, base.z), 2, 60000);
  await sealPosition(bot, base.entrance);
  return true;
}

async function exitBase(bot, base) {
  if (!base || !base.entrance) return false;
  const entPos = new Vec3(base.entrance.x, base.entrance.y, base.entrance.z);
  const block = bot.blockAt(entPos.offset(0, -1, 0));
  await gotoPos(bot, entPos.offset(0, -2, 0), 2, 30000);
  const doorBlock = bot.blockAt(entPos);
  if (doorBlock && doorBlock.name !== 'air') await safeDig(bot, doorBlock);
  await gotoPos(bot, entPos, 1, 15000);
  await sealPosition(bot, base.entrance);
  return true;
}

module.exports = {
  buildHiddenBase,
  enterBase,
  exitBase,
  depositExtras,
  sealPosition,
  pickBaseTarget
};
