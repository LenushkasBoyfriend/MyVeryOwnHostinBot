'use strict';

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
  return !!block && !LIQUID.has(block.name) && block.boundingBox === 'block';
}

function install(bot, mcData, config = {}) {
  if (!bot?.pathfinder) throw new Error('Pathfinder plugin is not loaded');
  const move = new Movements(bot, mcData);

  // Stable survival navigation: pathfinder is the normal movement owner.
  move.canDig = config.canDig !== false;
  move.canPlace = false;
  move.allowFreeMotion = false;
  move.allowParkour = true;
  move.allow1by1Towers = false;
  move.maxDropDown = 1;
  move.liquidCost = 80;
  move.fallDamageCost = 1000;
  move.digCost = 1.5;
  move.scafoldingBlocks = [];

  bot.pathfinder.setMovements(move);
  bot.__movement = bot.__movement || {};
  bot.__movement.move = move;
  bot.__movement.lastPosition = bot.entity?.position?.clone?.() || null;
  bot.__movement.lastProgressAt = Date.now();
  bot.__movement.lastGoalAt = 0;
  bot.__movement.lastJumpAt = 0;
  bot.__movement.recovering = false;
  return move;
}

function setGoal(bot, position, range = 1.8, timeoutMs = 12000) {
  if (!bot?.entity || !bot?.pathfinder || !position) return false;
  const p = position instanceof Vec3 ? position : new Vec3(position.x, position.y, position.z);
  try {
    bot.pathfinder.setGoal(new GoalNear(p.x, p.y, p.z, range), false);
    bot.__movement = bot.__movement || {};
    bot.__movement.lastGoalAt = Date.now();
    bot.__movement.goalTimeoutAt = Date.now() + timeoutMs;
    bot.__movement.recovering = false;
    return true;
  } catch (e) {
    console.log('[Movement] setGoal failed:', e.message);
    return false;
  }
}

async function walkTo(bot, position, range = 1.8, timeoutMs = 12000) {
  if (!bot?.entity || !bot?.pathfinder || !position) return false;
  const target = position instanceof Vec3 ? position : new Vec3(position.x, position.y, position.z);
  if (bot.entity.position.distanceTo(target) <= range) return true;

  clearControls(bot);
  if (!setGoal(bot, target, range, timeoutMs)) return false;

  const start = Date.now();
  let best = bot.entity.position.distanceTo(target);
  let lastProgress = start;

  return new Promise(resolve => {
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(deadline);
      try { bot.removeListener('goal_reached', onReached); } catch (_) {}
      try { bot.removeListener('path_update', onPath); } catch (_) {}
      // Do not clear the goal from another newer task.
      if (bot.__movement && bot.__movement.taskTarget === target) {
        try { bot.pathfinder.setGoal(null); } catch (_) {}
        bot.__movement.taskTarget = null;
      }
      resolve(ok);
    };
    const onReached = () => finish(true);
    const onPath = result => {
      if (result?.status === 'noPath') {
        if (Date.now() - start > 900) finish(false);
      }
    };

    bot.__movement.taskTarget = target;
    bot.once('goal_reached', onReached);
    bot.on('path_update', onPath);

    const timer = setInterval(() => {
      if (!bot?.entity) return finish(false);
      const d = bot.entity.position.distanceTo(target);
      if (d <= range + 0.3) return finish(true);
      if (d < best - 0.08) {
        best = d;
        lastProgress = Date.now();
      }
      if (Date.now() - lastProgress > 3500) return finish(false);
      if (Date.now() - start > timeoutMs) return finish(false);
    }, 180);
    const deadline = setTimeout(() => finish(false), timeoutMs + 150);
  });
}

function tryLocalJump(bot) {
  if (!bot?.entity || !bot?.pathfinder) return false;
  const m = bot.__movement || {};
  if (m.recovering || Date.now() - (m.lastJumpAt || 0) < 900) return false;
  if (!bot.pathfinder.goal) return false;

  const pos = bot.entity.position;
  const yaw = bot.entity.yaw;
  const fx = Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const bx = Math.floor(pos.x + fx * 0.9);
  const bz = Math.floor(pos.z + fz * 0.9);
  const feet = bot.blockAt(new Vec3(bx, Math.floor(pos.y), bz));
  const head = bot.blockAt(new Vec3(bx, Math.floor(pos.y) + 1, bz));
  const top = bot.blockAt(new Vec3(bx, Math.floor(pos.y) + 2, bz));
  if (!feet || !head || !top) return false;

  const obstacle = feet.boundingBox === 'block' && isAir(head) && isAir(top);
  if (!obstacle) return false;

  try {
    bot.setControlState('jump', true);
    m.lastJumpAt = Date.now();
    setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 180);
    return true;
  } catch (_) {
    return false;
  }
}

function findRecoveryTarget(bot, radius = 5) {
  if (!bot?.entity) return null;
  const o = bot.entity.position.floored();
  const dirs = [
    [1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]
  ];
  for (const [dx,dz] of dirs) {
    for (let dy = 1; dy >= -1; dy--) {
      const g = bot.blockAt(new Vec3(o.x + dx * radius / Math.max(1, radius), o.y + dy, o.z + dz * radius / Math.max(1, radius)));
      const feet = bot.blockAt(new Vec3(o.x + dx, o.y + dy + 1, o.z + dz));
      const head = bot.blockAt(new Vec3(o.x + dx, o.y + dy + 2, o.z + dz));
      if (safeGround(g) && isAir(feet) && isAir(head)) return new Vec3(o.x + dx + 0.5, o.y + dy + 1, o.z + dz + 0.5);
    }
  }
  return null;
}

function start(bot, mcData, config = {}, addInterval) {
  install(bot, mcData, { canDig: true });
  const cfg = config.movement || {};
  const monitorMs = Math.max(250, cfg.monitorIntervalMs || 350);
  const stuckMs = Math.max(3500, cfg.stuckMs || 4500);

  addInterval(() => {
    if (!bot?.entity || !bot?.pathfinder) return;
    const m = bot.__movement || {};
    const now = Date.now();
    const pos = bot.entity.position.clone();
    if (m.lastPosition && pos.distanceTo(m.lastPosition) > 0.12) m.lastProgressAt = now;
    m.lastPosition = pos;

    // No autonomous wandering: SurvivalAI/modules create the real tasks.
    if (!bot.pathfinder.goal) return;

    if (now - m.lastProgressAt > 800 && now - m.lastJumpAt > 900) tryLocalJump(bot);

    if (now - m.lastProgressAt > stuckMs && !m.recovering) {
      m.recovering = true;
      clearControls(bot);
      try { bot.pathfinder.stop(); } catch (_) {}
      const target = findRecoveryTarget(bot, 1);
      if (target) {
        setGoal(bot, target, 1.6, 5000);
      }
      setTimeout(() => { if (bot.__movement) bot.__movement.recovering = false; }, 700);
      m.lastProgressAt = now;
    }
  }, monitorMs);

  console.log('[Movement] Pathfinder navigation active; no idle wandering; jump assist enabled only for real 1-block obstacles.');
}

module.exports = { install, start, setGoal, walkTo, clearControls, tryLocalJump };
