'use strict';

/**
 * Single owner of navigation.
 * Never drives W/A/S/D or jump directly. mineflayer-pathfinder owns movement.
 */
const { Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const Vec3 = require('vec3');

const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUID = new Set(['water', 'bubble_column', 'lava']);

function clearControls(bot) {
  if (!bot || typeof bot.setControlState !== 'function') return;
  for (const key of CONTROL_KEYS) {
    try { bot.setControlState(key, false); } catch (_) {}
  }
}

function isAir(block) {
  return !!block && (AIR.has(block.name) || block.boundingBox === 'empty');
}

function safeGround(block) {
  if (!block) return false;
  if (LIQUID.has(block.name)) return false;
  return block.boundingBox === 'block';
}

function findSafeTarget(bot, radius = 10) {
  if (!bot?.entity) return null;
  const origin = bot.entity.position.floored();
  const candidates = [];

  for (let i = 0; i < 28; i++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 5 + Math.random() * Math.max(2, radius - 5);
    const x = Math.floor(origin.x + Math.cos(angle) * distance);
    const z = Math.floor(origin.z + Math.sin(angle) * distance);

    // Search a small vertical band for a real floor with two clear blocks above it.
    for (let y = origin.y + 3; y >= origin.y - 4; y--) {
      const ground = bot.blockAt(new Vec3(x, y, z));
      const feet = bot.blockAt(new Vec3(x, y + 1, z));
      const head = bot.blockAt(new Vec3(x, y + 2, z));
      if (!safeGround(ground) || !isAir(feet) || !isAir(head)) continue;

      // Avoid lava immediately below/next to the proposed destination.
      let dangerous = false;
      for (const [dx, dz] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
        const b = bot.blockAt(new Vec3(x + dx, y, z + dz));
        const below = bot.blockAt(new Vec3(x + dx, y - 1, z + dz));
        if (b && /lava/.test(b.name) || below && /lava/.test(below.name)) {
          dangerous = true;
          break;
        }
      }
      if (!dangerous) candidates.push(new Vec3(x + 0.5, y + 1, z + 0.5));
      break;
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const da = bot.entity.position.distanceTo(a);
    const db = bot.entity.position.distanceTo(b);
    return db - da; // prefer useful movement, not a 1-block shuffle
  });
  return candidates[0];
}

function install(bot, mcData, config = {}) {
  if (!bot?.pathfinder) throw new Error('Pathfinder plugin is not loaded');
  const move = new Movements(bot, mcData);

  // Conservative settings: Pathfinder must explicitly plan jumps and turns.
  move.allowFreeMotion = false;
  move.canDig = config.canDig !== false;
  move.canPlace = false;
  move.liquidCost = 20;
  move.fallDamageCost = 100;
  move.maxDropDown = 1;
  move.allow1by1towers = false;
  move.allowParkour = false;

  bot.pathfinder.setMovements(move);
  bot.__movement = bot.__movement || {};
  bot.__movement.move = move;
  bot.__movement.installedAt = Date.now();
  bot.__movement.busy = false;
  bot.__movement.lastPosition = bot.entity?.position?.clone?.() || null;
  bot.__movement.lastProgressAt = Date.now();
  bot.__movement.lastGoalAt = 0;
  bot.__movement.retries = 0;
  return move;
}

function setGoal(bot, position, range = 1.5, timeoutMs = 15000) {
  if (!bot?.entity || !bot?.pathfinder || !position) return false;
  const p = position instanceof Vec3 ? position : new Vec3(position.x, position.y, position.z);
  try {
    bot.pathfinder.setGoal(new GoalNear(p.x, p.y, p.z, range));
    bot.__movement = bot.__movement || {};
    bot.__movement.lastGoalAt = Date.now();
    bot.__movement.goalTimeoutAt = Date.now() + timeoutMs;
    return true;
  } catch (e) {
    console.log('[Movement] setGoal failed:', e.message);
    return false;
  }
}

async function walkTo(bot, position, range = 1.5, timeoutMs = 15000) {
  if (!bot?.entity || !bot?.pathfinder || !position) return false;
  const target = position instanceof Vec3 ? position : new Vec3(position.x, position.y, position.z);
  if (bot.entity.position.distanceTo(target) <= range) return true;

  clearControls(bot);
  if (!setGoal(bot, target, range, timeoutMs)) return false;

  const started = Date.now();
  let lastDistance = bot.entity.position.distanceTo(target);
  let lastProgress = Date.now();

  return await new Promise(resolve => {
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(timeout);
      try { bot.removeListener('goal_reached', onReached); } catch (_) {}
      try { bot.removeListener('path_update', onPath); } catch (_) {}
      try { bot.pathfinder.setGoal(null); } catch (_) {}
      resolve(ok);
    };
    const onReached = () => finish(true);
    const onPath = result => {
      if (result?.status === 'noPath') {
        // Give the pathfinder a short chance to rebuild before failing.
        setTimeout(() => {
          if (!done) setGoal(bot, target, range, timeoutMs);
        }, 250);
      }
    };
    const timer = setInterval(() => {
      if (!bot?.entity) return finish(false);
      const distance = bot.entity.position.distanceTo(target);
      if (distance <= range + 0.35) return finish(true);
      if (distance < lastDistance - 0.12) {
        lastDistance = distance;
        lastProgress = Date.now();
      }
      if (Date.now() - lastProgress > 5500) return finish(false);
      if (Date.now() - started > timeoutMs) return finish(false);
    }, 250);
    const timeout = setTimeout(() => finish(false), timeoutMs + 250);
    bot.once('goal_reached', onReached);
    bot.on('path_update', onPath);
  });
}

function start(bot, mcData, config = {}, addInterval) {
  install(bot, mcData, { canDig: true });
  const cfg = config.movement || {};
  const intervalMs = Math.max(500, cfg.idleGoalIntervalMs || 1200);
  const idleTimeout = Math.max(7000, cfg.stuckMs || 9000);

  addInterval(() => {
    if (!bot?.entity || !bot?.pathfinder) return;
    const m = bot.__movement || {};
    const current = bot.entity.position.clone();
    if (m.lastPosition && current.distanceTo(m.lastPosition) > 0.18) m.lastProgressAt = Date.now();
    m.lastPosition = current;

    // Other modules (gathering/mining/combat) temporarily own the goal.
    if (bot.__autonomyBusy || bot.pathfinder.goal) return;

    if (Date.now() - m.lastProgressAt < 1200) return;
    if (Date.now() - m.lastProgressAt > idleTimeout) {
      clearControls(bot);
      try { bot.pathfinder.stop(); } catch (_) {}
      m.retries = (m.retries || 0) + 1;
      m.lastProgressAt = Date.now();
    }

    const target = findSafeTarget(bot, cfg.idleRadius || 12);
    if (target) setGoal(bot, target, 1.5, cfg.idleGoalTimeoutMs || 12000);
  }, intervalMs);

  // First movement is deterministic: give the bot a nearby safe target shortly after spawn.
  setTimeout(() => {
    if (!bot?.entity || !bot?.pathfinder || bot.__autonomyBusy || bot.pathfinder.goal) return;
    const target = findSafeTarget(bot, cfg.idleRadius || 12);
    if (target) setGoal(bot, target, 1.5, cfg.idleGoalTimeoutMs || 12000);
  }, 1800);

  console.log('[Movement] Autonomous Pathfinder controller active. No forced W/jump movement.');
}

module.exports = { install, start, setGoal, walkTo, clearControls, findSafeTarget };
