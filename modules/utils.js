
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock } = goals;
const Vec3 = require('vec3');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

function stopMotion(bot) {
  if (!bot || typeof bot.setControlState !== 'function') return;
  for (const key of ['forward','back','left','right','jump','sprint','sneak']) {
    try { bot.setControlState(key, false); } catch (_) {}
  }
}

async function directRecoveryWalk(bot, pos, maxMs = 1800) {
  if (!bot?.entity || typeof bot.lookAt !== 'function' || typeof bot.setControlState !== 'function') return false;
  const start = bot.entity.position.clone();
  const started = Date.now();
  try {
    const target = new Vec3(pos.x, Math.max(pos.y, bot.entity.position.y), pos.z);
    await bot.lookAt(target.offset(0, 0.8, 0), true);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    while (Date.now() - started < maxMs) {
      if (!bot.entity) break;
      if (bot.entity.position.distanceTo(pos) <= 2.2) return true;
      await sleep(150);
    }
  } catch (_) {
  } finally {
    stopMotion(bot);
  }
  return bot.entity ? bot.entity.position.distanceTo(start) > 0.7 : false;
}

async function gotoPos(bot, pos, range = 1, timeoutMs = 30000) {
  if (!bot?.entity || !bot?.pathfinder || !pos) return false;
  const recovery = bot.__v12Movement || {};
  const retries = Math.max(1, recovery.retries || 3);
  const baseTimeout = timeoutMs || recovery.timeoutMs || 12000;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let timer = null;
    let interval = null;
    let reached = false;
    let lastDistance = Infinity;
    let lastProgressAt = Date.now();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
    };

    const result = await new Promise(resolve => {
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        cleanup();
        try { bot.removeListener('goal_reached', onReached); } catch (_) {}
        try { bot.removeListener('path_update', onPath); } catch (_) {}
        resolve(ok);
      };
      const onReached = () => finish(true);
      const onPath = r => {
        if (r?.status === 'noPath') {
          // Do not instantly fail: pathfinder can rebuild the route after a block change.
          setTimeout(() => {
            if (!done) {
              try { bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, range)); } catch (_) {}
            }
          }, 250);
        }
      };

      try {
        bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, range));
        bot.once('goal_reached', onReached);
        bot.on('path_update', onPath);
        interval = setInterval(() => {
          if (!bot?.entity) return finish(false);
          const d = bot.entity.position.distanceTo(pos);
          if (d <= range + 0.45) return finish(true);
          if (d < lastDistance - 0.15) {
            lastDistance = d;
            lastProgressAt = Date.now();
          } else if (Date.now() - lastProgressAt > Math.min(7000, baseTimeout * 0.6)) {
            finish(false);
          }
        }, 250);
        timer = setTimeout(() => finish(false), baseTimeout);
      } catch (_) {
        finish(false);
      }
    });

    if (result) return true;
    try { bot.pathfinder.stop(); } catch (_) {}
    stopMotion(bot);
    await sleep(250);

    if (attempt < retries) {
      const recovered = await directRecoveryWalk(bot, pos, 1200);
      if (recovered && bot.entity.position.distanceTo(pos) <= range + 1.5) return true;
    }
  }
  return false;
}

async function gotoBlock(bot, block, range = 2) {
  if (!block) return false;
  return gotoPos(bot, block.position, range, 12000);
}

function findNearestBlock(bot, names, maxDistance = 48, count = 1) {
  const nameSet = new Set(names);
  return bot.findBlocks({
    matching: b => !!b && nameSet.has(b.name), maxDistance, count
  }).map(pos => bot.blockAt(pos)).filter(Boolean);
}
function findOneBlock(bot, names, maxDistance = 48) {
  const nameSet = new Set(names);
  const pos = bot.findBlock({ matching: b => !!b && nameSet.has(b.name), maxDistance });
  return pos || null;
}

async function safeDig(bot, block) {
  if (!bot || !block) return false;
  try {
    if (bot.entity.position.distanceTo(block.position) > 4.0) {
      const ok = await gotoBlock(bot, block, 3);
      if (!ok) return false;
    }
    if (bot.tool?.equipForBlock) {
      try { await bot.tool.equipForBlock(block); } catch (_) {}
    }
    if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) return false;
    await bot.lookAt(block.position.offset(0.5,0.5,0.5), true);
    await bot.dig(block, true);
    return true;
  } catch (e) {
    log('Dig', `Hata (${block.name || 'block'}): ${e.message}`);
    return false;
  }
}

async function safePlace(bot, itemName, refBlock, faceVector) {
  if (!bot || !refBlock) return false;
  try {
    const item = bot.inventory.items().find(i => i.name === itemName);
    if (!item) return false;
    await bot.equip(item, 'hand');
    await bot.lookAt(refBlock.position.offset(0.5,0.5,0.5), true);
    await bot.placeBlock(refBlock, faceVector);
    return true;
  } catch (e) {
    log('Place', `Hata (${itemName}): ${e.message}`);
    return false;
  }
}
function countItem(bot, matcher) {
  const fn = typeof matcher === 'function' ? matcher : i => i.name === matcher;
  return bot.inventory.items().filter(fn).reduce((sum, i) => sum + i.count, 0);
}
function hasItem(bot, matcher, min = 1) { return countItem(bot, matcher) >= min; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

module.exports = { Vec3, sleep, log, gotoPos, gotoBlock, findNearestBlock, findOneBlock, safeDig, safePlace, countItem, hasItem, randInt, stopMotion };
