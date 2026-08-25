'use strict';
const { goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const Vec3 = require('vec3');
const movement = require('./movementController');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function log(tag, msg) { console.log(`[${tag}] ${msg}`); }
function stopMotion(bot) { movement.clearControls(bot); }

async function gotoPos(bot, pos, range = 1, timeoutMs = 30000) {
  if (!bot?.entity || !bot?.pathfinder || !pos) return false;
  const target = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z);
  return movement.walkTo(bot, target, range, timeoutMs);
}

async function gotoBlock(bot, block, range = 2) {
  if (!block) return false;
  return gotoPos(bot, block.position, range, 12000);
}

function findNearestBlock(bot, names, maxDistance = 48, count = 1) {
  const nameSet = new Set(names);
  return bot.findBlocks({ matching: b => !!b && nameSet.has(b.name), maxDistance, count }).map(pos => bot.blockAt(pos)).filter(Boolean);
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
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
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
    await bot.lookAt(refBlock.position.offset(0.5, 0.5, 0.5), true);
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

module.exports = { Vec3, sleep, log, gotoPos, gotoBlock, findNearestBlock, findOneBlock, safeDig, safePlace, countItem, hasItem, randInt, stopMotion, movement };
