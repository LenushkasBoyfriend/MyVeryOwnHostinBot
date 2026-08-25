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

// İki nokta arasında 1 genişliğinde, 2 yüksekliğinde düz bir koridor kazar
// (odaları birbirine bağlamak için). Yürüyerek gider, önündeki blokları kazar.
async function digCorridor(bot, from, to, height = 2) {
  const dx = Math.sign(to.x - from.x);
  const dz = Math.sign(to.z - from.z);
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.z - from.z));
  let cursor = from.clone ? from.clone() : new Vec3(from.x, from.y, from.z);
  for (let i = 0; i < steps; i++) {
    cursor = cursor.offset(dx, 0, dz);
    for (let dy = 0; dy < height; dy++) {
      const pos = cursor.offset(0, dy, 0);
      const block = bot.blockAt(pos);
      if (block && block.name !== 'air' && block.name !== 'cave_air') {
        await safeDig(bot, block);
      }
    }
    await gotoPos(bot, cursor, 1, 6000);
    await sleep(60);
  }
  return cursor;
}

// Bota "kendi tercihi" gibi görünen, elindeki malzemelere göre en güzel/en
// dayanıklı görünen döşeme-duvar malzemesini seçtirir. Sıralama estetik bir
// önceliğe göredir (parlatılmış/kesme taşlar > düz taş > toprak), ama seçim
// gerçekten envanterde ne varsa ona göre yapılır - sabit bir blok değil.
const AESTHETIC_PRIORITY = [
  'deepslate_tiles', 'polished_deepslate', 'chiseled_stone_bricks', 'stone_bricks',
  'polished_blackstone', 'polished_andesite', 'polished_diorite', 'polished_granite',
  'smooth_stone', 'oak_planks', 'spruce_planks', 'birch_planks', 'dark_oak_planks',
  'cobbled_deepslate', 'cobblestone', 'stone'
];

function choosePalette(bot) {
  for (const name of AESTHETIC_PRIORITY) {
    if (countItem(bot, name) >= 12) return name;
  }
  // Hiçbiri yoksa, elde bol miktarda ne varsa (taş/toprak türevi) onu kullan.
  const fallback = bot.inventory.items().find(i => /stone|cobble|deepslate|granite|andesite|diorite|planks/.test(i.name) && i.count >= 8);
  return fallback ? fallback.name : null;
}

// Bir odanın zeminini seçilen malzemeyle kaplar ve köşelerine ışık kaynağı koyar.
// Amaç kusursuz bir yapı değil, çıplak mağara yerine "birisi burada yaşıyor"
// hissi veren, gerçek bir oyuncunun elle yapacağı türden basit bir dekorasyon.
async function decorateRoom(bot, mcData, center, size, palette) {
  const { w, l } = size;
  const hw = Math.floor(w / 2), hl = Math.floor(l / 2);

  if (palette) {
    for (let dx = -hw; dx <= hw; dx += 1) {
      for (let dz = -hl; dz <= hl; dz += 1) {
        if (!bot.inventory.items().some(i => i.name === palette)) break;
        const floorPos = center.offset(dx, -1, dz);
        const floorBlock = bot.blockAt(floorPos);
        if (!floorBlock || floorBlock.name === palette) continue;
        try {
          await safeDig(bot, floorBlock);
          await sealPosition(bot, { x: floorPos.x, y: floorPos.y, z: floorPos.z, blockName: palette });
        } catch (e) { /* bir kare başarısız olursa devam et */ }
      }
    }
  }

  // Işıklandırma: torch yoksa ve malzeme varsa üretmeyi dene.
  const inv = require('./inventory');
  if (!bot.inventory.items().some(i => i.name === 'torch') && countItem(bot, i => /coal|charcoal/.test(i.name)) > 0 && countItem(bot, 'stick') > 0) {
    try { await inv.craftItemByName(bot, mcData, 'torch', 4, null); } catch (e) { }
  }
  const torch = bot.inventory.items().find(i => i.name === 'torch' || i.name === 'lantern');
  if (torch) {
    const corners = [
      center.offset(hw, 0, hl), center.offset(-hw, 0, hl),
      center.offset(hw, 0, -hl), center.offset(-hw, 0, -hl)
    ];
    for (const corner of corners) {
      if (!bot.inventory.items().some(i => i.name === torch.name)) break;
      const wallRef = bot.blockAt(corner.offset(0, -1, 0));
      try { await safePlace(bot, torch.name, wallRef, new Vec3(0, 1, 0)); } catch (e) { }
    }
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
// Tek bir oda yerine birbirine koridorla bağlı, işlevine göre ayrılmış
// odalar kurar: bir ana salon (crafting/furnace), bir depo odası, ve
// (yer/malzeme uygunsa) yer altı bir çiftlik odası. Zemin, elde bulunan
// malzemelerden botun kendisinin seçtiği bir "güzel" blokla kaplanır.
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

  const hallSize = config.roomSize || { w: 5, h: 4, l: 5 };
  const hallCenter = bot.entity.position.floored().offset(0, 0, 0);
  await carveRoom(bot, hallCenter, hallSize);
  await placeFurnitureInBase(bot, mcData, hallCenter);

  const palette = choosePalette(bot);
  if (palette) log('Base', `Dekorasyon için seçilen blok: ${palette}`);
  await decorateRoom(bot, mcData, hallCenter, hallSize, palette);

  // Depo odası: ana salonun bir yanında, koridorla bağlı ayrı bir oda.
  // chestSystem.js burayı kategori sandıklarını yerleştirmek için kullanır.
  const rooms = { hall: { x: hallCenter.x, y: hallCenter.y, z: hallCenter.z } };
  try {
    const storageOffset = hallCenter.offset(Math.floor(hallSize.w / 2) + 3, 0, 0);
    await digCorridor(bot, hallCenter, storageOffset);
    const storageCenter = bot.entity.position.floored();
    await carveRoom(bot, storageCenter, { w: 5, h: 3, l: 5 });
    await decorateRoom(bot, mcData, storageCenter, { w: 5, h: 3, l: 5 }, palette);
    rooms.storage = { x: storageCenter.x, y: storageCenter.y, z: storageCenter.z };
    await gotoPos(bot, hallCenter, 1, 15000);
  } catch (e) {
    log('Base', `Depo odası kurulamadı, ana salon kullanılacak: ${e.message}`);
  }

  const base = {
    x: hallCenter.x, y: hallCenter.y, z: hallCenter.z,
    entrance: entrancePos,
    shaftPath: shaftRecord,
    rooms,
    palette
  };

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

  base.entrance = entranceEntry ? { x: entranceEntry.x, y: entranceEntry.y, z: entranceEntry.z, blockName: entranceEntry.blockName } : entrancePos;
  state.base = base;
  saveState(state);
  log('Base', `Gizli üs tamamlandı: (${base.x}, ${base.y}, ${base.z}). Giriş: (${base.entrance.x}, ${base.entrance.y}, ${base.entrance.z}). Odalar: ${Object.keys(rooms).join(', ')}`);
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
  pickBaseTarget,
  choosePalette,
  carveRoom,
  digCorridor,
  decorateRoom
};
