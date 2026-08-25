'use strict';
// Ortak, düşük seviyeli yardımcı fonksiyonlar.
// Bütün Survival AI modülleri bu dosyadaki fonksiyonları kullanır.

const { goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock } = goals;
const Vec3 = require('vec3');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

// Bota, verilen pozisyona belirli bir mesafeye kadar yürütür.
async function gotoPos(bot, pos, range = 1, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (!bot || !bot.pathfinder) return resolve(false);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, range));
      const check = setInterval(() => {
        if (!bot || !bot.entity) { clearInterval(check); clearTimeout(timer); finish(false); return; }
        if (bot.entity.position.distanceTo(pos) <= range + 0.5) {
          clearInterval(check);
          clearTimeout(timer);
          finish(true);
        }
      }, 500);
      bot.once('goal_reached', () => { clearInterval(check); clearTimeout(timer); finish(true); });
      bot.once('path_update', (r) => {
        if (r.status === 'noPath') { clearInterval(check); clearTimeout(timer); finish(false); }
      });
    } catch (e) {
      clearTimeout(timer);
      finish(false);
    }
  });
}

async function gotoBlock(bot, block, range = 2) {
  if (!block) return false;
  return gotoPos(bot, block.position, range);
}

// En yakın eşleşen bloğu bulur (verilen isim listesine göre).
function findNearestBlock(bot, names, maxDistance = 48, count = 1) {
  const nameSet = new Set(names);
  return bot.findBlocks({
    matching: (block) => block && nameSet.has(block.name),
    maxDistance,
    count
  }).map(pos => bot.blockAt(pos));
}

function findOneBlock(bot, names, maxDistance = 48) {
  const nameSet = new Set(names);
  const pos = bot.findBlock({
    matching: (block) => block && nameSet.has(block.name),
    maxDistance
  });
  return pos || null;
}

// Bir bloğu güvenli şekilde kazar: aracı otomatik seçer (mineflayer-tool varsa),
// hedefe yürür, kazar.
async function safeDig(bot, block) {
  if (!bot || !block) return false;
  try {
    if (bot.entity.position.distanceTo(block.position) > 4.2) {
      const ok = await gotoBlock(bot, block, 3);
      if (!ok) return false;
    }
    if (bot.tool && typeof bot.tool.equipForBlock === 'function') {
      try { await bot.tool.equipForBlock(block); } catch (e) { /* aracı yoksa devam et */ }
    }
    if (!bot.canDigBlock(block)) return false;
    await bot.dig(block);
    return true;
  } catch (e) {
    log('Dig', `Hata: ${e.message}`);
    return false;
  }
}

// Belirtilen pozisyona, elde tutulan bir bloğu yerleştirmeye çalışır.
// refBlock: yerleştirme referansı olacak komşu blok, faceVector: hangi yüzeye.
async function safePlace(bot, itemName, refBlock, faceVector) {
  if (!bot || !refBlock) return false;
  try {
    const item = bot.inventory.items().find(i => i.name === itemName);
    if (!item) return false;
    await bot.equip(item, 'hand');
    await bot.placeBlock(refBlock, faceVector);
    return true;
  } catch (e) {
    log('Place', `Hata (${itemName}): ${e.message}`);
    return false;
  }
}

function countItem(bot, matcher) {
  const fn = typeof matcher === 'function' ? matcher : (i) => i.name === matcher;
  return bot.inventory.items().filter(fn).reduce((sum, i) => sum + i.count, 0);
}

function hasItem(bot, matcher, min = 1) {
  return countItem(bot, matcher) >= min;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {
  Vec3,
  sleep,
  log,
  gotoPos,
  gotoBlock,
  findNearestBlock,
  findOneBlock,
  safeDig,
  safePlace,
  countItem,
  hasItem,
  randInt
};
