'use strict';
// Odun/taş/cevher toplama ve yiyecek avlama.

const { log, gotoBlock, gotoPos, findOneBlock, safeDig, countItem, sleep, randInt, Vec3 } = require('./utils');

const LOG_MATCH = (name) => /_log$/.test(name) || /_stem$/.test(name);
const STONE_LIKE = ['stone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'tuff'];

// Bir bloğu kazdıktan sonra, orijinal blok tipini not ederek arkasını
// aynı türden bir blokla kapatabilmek için kullanılır (baseBuilder ile paylaşılır).
async function digTrackingType(bot, block) {
  if (!block) return null;
  const originalName = block.name;
  const pos = block.position.clone ? block.position.clone() : block.position;
  const ok = await safeDig(bot, block);
  if (ok) {
    // Düşen eşyayı toplamak için kazılan boşluğa doğru kısa bir adım at.
    try { await gotoPos(bot, pos, 1, 3000); } catch (e) { }
  }
  return ok ? originalName : null;
}

// En yakın ağacı bulup kütükleri toplar. target: toplanacak toplam kütük sayısı.
async function gatherWood(bot, mcData, target = 24) {
  let attempts = 0;
  let radius = 24;
  while (countItem(bot, i => LOG_MATCH(i.name)) < target && attempts < 40) {
    attempts++;
    const pos = bot.findBlock({ matching: (b) => b && LOG_MATCH(b.name), maxDistance: radius });
    if (!pos) {
      radius = Math.min(radius + 16, 96);
      // Ağaç bulunamıyorsa rastgele bir yöne yürü.
      const p = bot.entity.position;
      await gotoPos(bot, p.offset(randInt(-20, 20), 0, randInt(-20, 20)), 2, 8000);
      continue;
    }
    const block = bot.blockAt(pos);
    await digTrackingType(bot, block);
    await sleep(150);
  }
  return countItem(bot, i => LOG_MATCH(i.name));
}

// Yüzeydeki taşı toplar; bulamazsa aşağı doğru merdiven şeklinde iner.
async function mineStone(bot, mcData, target = 32) {
  let attempts = 0;
  while (countItem(bot, i => i.name === 'cobblestone' || i.name === 'cobbled_deepslate') < target && attempts < 60) {
    attempts++;
    const pos = bot.findBlock({ matching: (b) => b && STONE_LIKE.includes(b.name), maxDistance: 40 });
    if (pos) {
      const block = bot.blockAt(pos);
      await digTrackingType(bot, block);
      await sleep(120);
      continue;
    }
    // Görünürde taş yoksa aşağı in.
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (below && (below.name === 'air' || below.name === 'cave_air')) {
      await sleep(300);
      continue;
    }
    await digTrackingType(bot, below);
    await sleep(150);
  }
  return countItem(bot, i => i.name === 'cobblestone' || i.name === 'cobbled_deepslate');
}

const ORE_GROUPS = {
  coal: ['coal_ore', 'deepslate_coal_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  lapis: ['lapis_ore', 'deepslate_lapis_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore']
};

// Bota tehlikeli boşluklara (lava, boşluk) düşmemesi için basit bir kontrol.
function isSafeToStepInto(bot, pos) {
  const b = bot.blockAt(pos);
  const below = bot.blockAt(pos.offset(0, -1, 0));
  if (!b || !below) return false;
  if (b.name === 'lava' || b.name === 'flowing_lava') return false;
  if (below.name === 'lava' || below.name === 'flowing_lava') return false;
  return true;
}

// Belirli bir Y seviyesine kadar merdivenli bir tünel kazarak cevher arar.
// oreNames: aranacak cevher blok isimleri dizisi.
async function stripMineForOres(bot, mcData, oreNames, targetCount, targetY, maxSteps = 250) {
  let found = 0;
  let steps = 0;
  const startDir = Math.floor(Math.random() * 4); // 0:+x 1:-x 2:+z 3:-z
  const dirVec = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)][startDir];

  // Önce hedef derinliğe in.
  while (bot.entity.position.y > targetY + 1 && steps < maxSteps) {
    steps++;
    const below = bot.blockAt(bot.entity.position.offset(0, -2, 0));
    if (below && below.name !== 'air' && below.name !== 'cave_air' && !below.name.includes('lava')) {
      await digTrackingType(bot, bot.blockAt(bot.entity.position.offset(0, -1, 0)));
      await digTrackingType(bot, below);
      await gotoPos(bot, bot.entity.position.offset(0, -1, 0), 0, 4000);
    } else {
      break;
    }
    await sleep(100);
  }

  // Cevher arayarak yatay ilerle (2 yüksekliğinde tünel).
  while (found < targetCount && steps < maxSteps) {
    steps++;
    const nearOre = bot.findBlock({
      matching: (b) => b && oreNames.includes(b.name),
      maxDistance: 24
    });
    if (nearOre) {
      const block = bot.blockAt(nearOre);
      const ok = await digTrackingType(bot, block);
      if (ok) found++;
      await sleep(150);
      continue;
    }
    // Cevher yoksa tünele devam et.
    const front = bot.entity.position.plus(dirVec);
    const frontBlockHead = bot.blockAt(front.offset(0, 1, 0));
    const frontBlockFeet = bot.blockAt(front);
    if (frontBlockHead && frontBlockHead.name !== 'air') await digTrackingType(bot, frontBlockHead);
    if (frontBlockFeet && frontBlockFeet.name !== 'air') await digTrackingType(bot, frontBlockFeet);
    if (isSafeToStepInto(bot, front)) {
      await gotoPos(bot, front, 0, 4000);
    } else {
      break; // tehlikeli, dur
    }
    await sleep(120);
  }
  return found;
}

// Yakındaki evcil/pasif hayvanları avlar (yemek için et).
async function huntNearbyAnimal(bot) {
  const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit']);
  const entity = Object.values(bot.entities).find(e =>
    e.name && ANIMALS.has(e.name) && e.position && bot.entity.position.distanceTo(e.position) < 32
  );
  if (!entity) return false;
  try {
    await gotoPos(bot, entity.position, 2, 15000);
    if (bot.entity.position.distanceTo(entity.position) < 4) {
      bot.attack(entity);
      await sleep(600);
      return true;
    }
  } catch (e) {
    log('Hunt', `Hata: ${e.message}`);
  }
  return false;
}

module.exports = {
  LOG_MATCH,
  STONE_LIKE,
  ORE_GROUPS,
  gatherWood,
  mineStone,
  stripMineForOres,
  huntNearbyAnimal,
  digTrackingType
};
