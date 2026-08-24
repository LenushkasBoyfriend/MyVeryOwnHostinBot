'use strict';
// Yer altında, rastgele bir konumda, gizli bir üs inşa eder ve
// giriş tünelini arkadan kapatarak (aynı blok tipleriyle) izleri gizler.

const { log, gotoPos, safeDig, safePlace, countItem, sleep, randInt, Vec3 } = require('./utils');
const { loadState, saveState } = require('./state');
const baseDesign = require('./baseDesign');
const gathering = require('./gathering');


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
  const origin = bot.entity.position;
  const choices = [];
  for (let i = 0; i < 12; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = randInt(minR, maxR);
    choices.push({ x: Math.floor(origin.x + Math.cos(angle) * dist), z: Math.floor(origin.z + Math.sin(angle) * dist), depth: randInt(minD, maxD) });
  }
  // Prefer a location that is reasonably flat, has access to trees/water, and is not swamped.
  // Unknown/unloaded terrain gets a neutral score rather than being treated as unsafe.
  const score = (candidate) => {
    let s = 0;
    const y = Math.floor(bot.entity.position.y);
    let same = 0, hazards = 0, trees = 0, water = 0;
    for (let dx = -4; dx <= 4; dx += 2) for (let dz = -4; dz <= 4; dz += 2) {
      const b = bot.blockAt(new Vec3(candidate.x + dx, y, candidate.z + dz));
      const below = bot.blockAt(new Vec3(candidate.x + dx, y - 1, candidate.z + dz));
      if (b?.name === 'air' || b?.name === 'grass' || b?.name === 'short_grass') same += 1;
      if (/lava|fire/.test(b?.name || '') || /lava/.test(below?.name || '')) hazards += 2;
      if (/(oak|spruce|birch|jungle|acacia|dark_oak)_log/.test(b?.name || '')) trees += 1;
      if (/water/.test(b?.name || '')) water += 1;
    }
    s += same * 2 + trees * 3 + Math.min(3, water);
    s -= hazards * 8;
    return s;
  };
  choices.sort((a, b) => score(b) - score(a));
  return choices[0];
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

// Bot önce malzemesini toplar, sonra kendi seçtiği palet ve oda planıyla üssünü kurar.
async function ensureBuildMaterials(bot, mcData, config = {}) {
  const mainTargets = ['stone_bricks', 'polished_deepslate', 'deepslate_bricks', 'spruce_planks', 'oak_planks', 'cobblestone'];
  const haveBuilding = mainTargets.reduce((n, name) => n + countItem(bot, name), 0);
  if (haveBuilding < 32) {
    try { await gathering.gatherWood(bot, mcData, 24); } catch (_) {}
    try { await gathering.mineStone(bot, mcData, 64); } catch (_) {}
  }
  if (countItem(bot, 'torch') < 12) {
    try { await invEnsureTorch(bot, mcData); } catch (_) {}
  }
}

async function invEnsureTorch(bot, mcData) {
  const inv = require('./inventory');
  const table = await inv.ensureCraftingTable(bot, mcData);
  if (table) {
    try { await inv.craftAnyItem(bot, mcData, 'torch', 24, { maxDepth: 6, table }); } catch (_) {}
  }
}

function chooseStyleName(palette) {
  if (/deepslate/.test(palette.main) && /spruce/.test(palette.floor)) return 'dark-underground-lodge';
  if (/stone_bricks/.test(palette.main)) return 'stone-workshop';
  return 'compact-survival-home';
}

async function decorateRoom(bot, center, spec, palette) {
  const { w, h, l } = spec.size;
  const hw = Math.floor(w / 2), hl = Math.floor(l / 2);
  // Floor border / inlay. Only place onto already solid blocks.
  if (palette.floor) {
    for (let dx = -hw; dx <= hw; dx++) {
      for (let dz = -hl; dz <= hl; dz++) {
        const target = center.offset(dx, 0, dz);
        const below = bot.blockAt(target.offset(0, -1, 0));
        if (!below || below.boundingBox !== 'block') continue;
        const existing = bot.blockAt(target);
        if (existing && existing.name !== palette.floor && existing.name !== 'air' && existing.name !== 'cave_air') continue;
        await safePlace(bot, palette.floor, below, new Vec3(0, 1, 0));
      }
    }
  }
  // Symmetric corner lighting makes the rooms readable and avoids ugly spam.
  if (palette.light) {
    const points = [
      center.offset(-hw + 1, 1, -hl + 1),
      center.offset(hw - 1, 1, -hl + 1),
      center.offset(-hw + 1, 1, hl - 1),
      center.offset(hw - 1, 1, hl - 1)
    ];
    for (const pos of points) {
      const below = bot.blockAt(pos.offset(0, -1, 0));
      const target = bot.blockAt(pos);
      if (target && (target.name === 'air' || target.name === 'cave_air') && below?.boundingBox === 'block') {
        await safePlace(bot, palette.light, below, new Vec3(0, 1, 0));
      }
    }
  }
  // One accent wall line: cheap, symmetric, and easy to maintain.
  if (palette.accent) {
    for (let dx = -hw + 1; dx <= hw - 1; dx += 2) {
      const target = center.offset(dx, 1, -hl);
      const below = bot.blockAt(target.offset(0, -1, 0));
      if (below?.boundingBox === 'block' && (bot.blockAt(target)?.name === 'air' || bot.blockAt(target)?.name === 'cave_air')) {
        await safePlace(bot, palette.accent, below, new Vec3(0, 1, 0));
      }
    }
  }
}

async function placeRoomFurniture(bot, mcData, roomId, center) {
  const inv = require('./inventory');
  const pos = center;
  const place = async (item, x, y, z) => {
    const target = pos.offset(x, y, z);
    const below = bot.blockAt(target.offset(0, -1, 0));
    if (below?.boundingBox !== 'block') return false;
    return safePlace(bot, item, below, new Vec3(0, 1, 0));
  };
  try {
    if (roomId === 'storage') {
      if (countItem(bot, 'chest') < 6) {
        await inv.ensureCraftingTable(bot, mcData);
        try { await inv.craftAnyItem(bot, mcData, 'chest', 6 - countItem(bot, 'chest'), { maxDepth: 6 }); } catch (_) {}
      }
      const spots = [[-2,0,-2],[0,0,-2],[2,0,-2],[-2,0,2],[0,0,2],[2,0,2]];
      for (const [x,y,z] of spots) if (countItem(bot,'chest')>0) await place('chest',x,y,z);
    } else if (roomId === 'workshop') {
      if (countItem(bot,'crafting_table') < 1) await inv.ensureCraftingTable(bot, mcData);
      await place('crafting_table', 0, 0, 0);
      if (countItem(bot,'anvil') > 0) await place('anvil', 1, 0, 0);
      if (countItem(bot,'crafting_table') > 1) await place('crafting_table', -1, 0, 0);
    } else if (roomId === 'smeltery') {
      if (countItem(bot,'furnace') < 3) {
        try { await inv.ensureFurnace(bot, mcData); } catch (_) {}
      }
      for (const [x,z] of [[-2,-1],[0,-1],[2,-1]]) if (countItem(bot,'furnace') > 0) await place('furnace',x,0,z);
    } else if (roomId === 'enchant') {
      if (countItem(bot,'enchanting_table') > 0) await place('enchanting_table',0,0,0);
    } else if (roomId === 'bedroom') {
      const beds = bot.inventory.items().find(i => /_bed$/.test(i.name));
      if (beds) await place(beds.name,0,0,0);
      if (countItem(bot,'chest')>0) await place('chest',2,0,1);
    } else if (roomId === 'farm') {
      // The farming module manages irrigation; the room itself stays open for crop work.
    }
  } catch (e) { log('Base', `Mobilya (${roomId}) hatası: ${e.message}`); }
}

async function buildHiddenBase(bot, mcData, config = {}) {
  const state = loadState();
  if (state.base) {
    if (config.buildRooms !== false) await buildRooms(bot, mcData, state.base, config);
    return state.base;
  }

  await ensureBuildMaterials(bot, mcData, config);
  const targetInfo = pickBaseTarget(bot, config);
  log('Base', `Üs bölgesi seçiliyor: ${targetInfo.x}, ${targetInfo.z}`);
  await walkToSurfaceXZ(bot, targetInfo.x, targetInfo.z);

  const surfaceY = Math.floor(bot.entity.position.y);
  const targetY = surfaceY - targetInfo.depth;
  const shaftRecord = [];
  const entrancePos = { x: Math.floor(bot.entity.position.x), y: surfaceY, z: Math.floor(bot.entity.position.z) };
  await digShaftDown(bot, targetY, shaftRecord);

  const roomCenter = bot.entity.position.floored();
  await carveRoom(bot, roomCenter, config.roomSize || { w: 7, h: 5, l: 7 });

  // First decide on a style from what the bot actually owns.
  const palette = baseDesign.choosePalette(bot);
  const style = chooseStyleName(palette);
  state.baseDesign = state.baseDesign || {};
  state.baseDesign.palette = palette;
  state.baseDesign.style = style;
  saveState(state);
  log('Base', `Kendi yapı stilini seçti: ${style} (${palette.main}/${palette.floor})`);

  const base = {
    x: roomCenter.x, y: roomCenter.y, z: roomCenter.z,
    entrance: entrancePos,
    shaftPath: shaftRecord,
    rooms: {}
  };
  state.base = base;
  state.home = { x: base.x, y: base.y, z: base.z, type: 'designed-underground-home', style, createdAt: Date.now(), reasons: ['safe', 'expandable', 'self-designed'] };
  saveState(state);

  if (config.buildRooms !== false) await buildRooms(bot, mcData, base, config);

  // Close the shaft after the interior is safe. Leave the current underground room reachable through state.
  log('Base', 'Giriş tüneli kamufle ediliyor...');
  const toSeal = shaftRecord.slice().reverse();
  const entranceEntry = toSeal.shift();
  for (const entry of toSeal) { await sealPosition(bot, entry); await sleep(60); }
  await gotoPos(bot, new Vec3(entrancePos.x, entrancePos.y, entrancePos.z), 1, 15000);
  if (entranceEntry) await sealPosition(bot, entranceEntry);
  base.entrance = entranceEntry ? { x: entranceEntry.x, y: entranceEntry.y, z: entranceEntry.z, blockName: entranceEntry.blockName } : entrancePos;
  state.base = base;
  saveState(state);
  log('Base', `Kişisel ana üs tamamlandı: (${base.x}, ${base.y}, ${base.z})`);
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

// Odayı aşamalı inşa eder; her oda kendi planından, paletinden ve işlevinden oluşur.
async function buildRooms(bot, mcData, base, config = {}) {
  const state = loadState();
  state.baseRooms = state.baseRooms || {};
  state.baseDesign = state.baseDesign || {};
  const palette = state.baseDesign.palette || baseDesign.choosePalette(bot);
  const layout = baseDesign.chooseRoomLayout(config);
  const built = {};
  for (const spec of layout) {
    if (state.baseRooms[spec.id]?.built) { built[spec.id] = state.baseRooms[spec.id]; continue; }
    const center = baseDesign.roomCenter(base, spec);
    // Short 3x3 connector from the central hall to the room.
    const dx = Math.sign(spec.dx), dz = Math.sign(spec.dz);
    for (let i = 1; i <= Math.max(Math.abs(spec.dx), Math.abs(spec.dz)); i++) {
      const c = new Vec3(base.x + dx * i, base.y, base.z + dz * i);
      await carveRoom(bot, c, { w: 3, h: 3, l: 3 });
    }
    await carveRoom(bot, center, spec.size);
    await decorateRoom(bot, center, spec, palette);
    await placeRoomFurniture(bot, mcData, spec.id, center);
    state.baseRooms[spec.id] = { built: true, id: spec.id, name: spec.name, x: center.x, y: center.y, z: center.z, size: spec.size, builtAt: Date.now() };
    state.baseDesign.roomsBuilt[spec.id] = true;
    built[spec.id] = state.baseRooms[spec.id];
    saveState(state);
    log('Base', `Oda tamamlandı: ${spec.name}.`);
    await sleep(180);
  }
  state.base.rooms = built;
  saveState(state);
  return built;
}

const CHEST_CATEGORIES = {
  food: n => /cooked_|bread|apple|carrot|potato|beetroot|melon|pumpkin|fish/.test(n),
  ores: n => /ore|raw_|ingot|diamond|emerald|gold|iron|coal|charcoal|redstone|lapis|quartz|amethyst/.test(n),
  building: n => /stone|cobble|deepslate|dirt|sand|gravel|glass|brick|planks|log|wood|concrete|terracotta|wool/.test(n),
  tools: n => /pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots|shield|bow|crossbow|trident/.test(n),
  farming: n => /seed|wheat|carrot|potato|beetroot|bone_meal|sugar_cane|cocoa/.test(n),
  redstone: n => /redstone|repeater|comparator|observer|piston|hopper|dropper|dispenser|lever|button|rail/.test(n),
  blocks: n => /block$|_block$|glass|slab|stairs|fence|door|trapdoor|sign/.test(n),
  misc: () => true
};

function categoryFor(name) {
  for (const [category, fn] of Object.entries(CHEST_CATEGORIES)) if (fn(name)) return category;
  return 'misc';
}

async function ensureCategoryChests(bot, mcData, base, categories) {
  const state = loadState();
  state.storage = state.storage || { version: 1, categoryChests: {}, lastSortAt: 0 };
  const room = state.baseRooms?.storage || state.base?.rooms?.storage;
  if (!room) return false;
  const inv = require('./inventory');
  const spots = Object.entries(categories).map(([, category], i) => ({ category, x: room.x + ((i % 3) - 1) * 2, z: room.z + (i < 3 ? -2 : 2) }));
  for (const slot of spots) {
    if (state.storage.categoryChests[slot.category]) continue;
    if (countItem(bot, 'chest') < 1) { try { await inv.craftAnyItem(bot, mcData, 'chest', 1, { maxDepth: 6 }); } catch (_) {} }
    const target = new Vec3(slot.x, room.y, slot.z);
    const below = bot.blockAt(target.offset(0, -1, 0));
    if (below?.boundingBox === 'block' && countItem(bot, 'chest') > 0 && await safePlace(bot, 'chest', below, new Vec3(0, 1, 0))) {
      state.storage.categoryChests[slot.category] = { x: target.x, y: target.y, z: target.z };
    }
  }
  saveState(state);
  return true;
}

async function organizeChests(bot, mcData, radius = 12) {
  const state = loadState();
  if (!state.base) return false;
  const categoryNames = Object.keys(CHEST_CATEGORIES);
  await ensureCategoryChests(bot, mcData, state.base, categoryNames);
  const mapping = state.storage?.categoryChests || {};
  const reserved = new Set(Object.values(mapping).map(p => `${p.x},${p.y},${p.z}`));

  // First collect misplaced contents from nearby chests. The bot deliberately
  // does not keep everything in one "misc" chest forever.
  if (typeof bot.findBlocks === 'function') {
    const ids = ['chest', 'trapped_chest'].map(n => bot.registry?.blocksByName?.[n]?.id).filter(Number.isInteger);
    const positions = ids.length ? bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 }) : [];
    for (const pos of positions) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (reserved.has(key)) continue;
      const block = bot.blockAt(pos);
      if (!block) continue;
      try {
        await gotoPos(bot, block.position, 2, 8000);
        const win = await bot.openContainer(block);
        for (const item of win.containerItems()) {
          try { await win.withdraw(item.type, null, item.count); } catch (_) {}
        }
        win.close();
      } catch (_) {}
    }
  }

  for (const [category, pos] of Object.entries(mapping)) {
    const chestBlock = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!chestBlock || !/chest/.test(chestBlock.name)) continue;
    try {
      await gotoPos(bot, chestBlock.position, 2, 10000);
      const win = await bot.openContainer(chestBlock);
      for (const item of bot.inventory.items().slice()) {
        if (categoryFor(item.name) !== category) continue;
        try { await win.deposit(item.type, null, item.count); } catch (_) {}
      }
      win.close();
    } catch (e) { log('Storage', `Kategori sandığı (${category}) hatası: ${e.message}`); }
  }
  state.storage.lastSortAt = Date.now();
  saveState(state);
  return Object.keys(mapping).length > 0;
}
module.exports.buildRooms = buildRooms;
module.exports.organizeChests = organizeChests;
module.exports.categoryFor = categoryFor;
module.exports.ensureCategoryChests = ensureCategoryChests;
