'use strict';

const { Vec3, gotoPos, sleep, countItem, stopMotion, log } = require('./utils');

const HOSTILES = new Set([
  'zombie','husk','drowned','skeleton','stray','bogged','creeper','spider','cave_spider',
  'witch','pillager','vindicator','evoker','ravager','phantom','slime','magma_cube',
  'enderman','silverfish','endermite','blaze','ghast','piglin_brute','hoglin','zoglin'
]);

function nearestThreat(bot, radius) {
  return Object.values(bot.entities || {})
    .filter(e => e && e.position && e.type !== 'player' && HOSTILES.has(e.name))
    .filter(e => bot.entity.position.distanceTo(e.position) <= radius)
    .sort((a,b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0] || null;
}

function chooseWeapon(bot) {
  const preferred = bot.inventory.items().filter(i => /_(sword)$/.test(i.name));
  preferred.sort((a,b) => {
    const rank = n => /netherite/.test(n) ? 5 : /diamond/.test(n) ? 4 : /iron/.test(n) ? 3 : /stone/.test(n) ? 2 : 1;
    return rank(b.name) - rank(a.name);
  });
  return preferred[0] || bot.inventory.items().find(i => /_(axe)$/.test(i.name)) || null;
}

function chooseFood(bot, mcData) {
  return bot.inventory.items().find(i => {
    const f = mcData.foods && Object.values(mcData.foods).find(x => x.id === i.type);
    return f && f.foodPoints > 0;
  }) || null;
}

async function equipWeapon(bot) {
  const w = chooseWeapon(bot);
  if (!w || !bot.equip) return w;
  try { await bot.equip(w, 'hand'); } catch (_) {}
  return w;
}

async function retreat(bot, target, distance = 6) {
  if (!bot?.entity || !target?.position) return false;
  const away = bot.entity.position.minus(target.position);
  const len = Math.max(0.01, Math.sqrt(away.x * away.x + away.z * away.z));
  const pos = bot.entity.position.plus(new Vec3((away.x / len) * distance, 0, (away.z / len) * distance));
  stopMotion(bot);
  return gotoPos(bot, pos, 1, 5000);
}

async function sidestep(bot, target) {
  const dx = target.position.x - bot.entity.position.x;
  const dz = target.position.z - bot.entity.position.z;
  const side = Math.abs(dx) > Math.abs(dz) ? new Vec3(0,0,Math.sign(dx) || 1) : new Vec3(Math.sign(dz) || 1,0,0);
  const pos = bot.entity.position.plus(side);
  try {
    await bot.lookAt(target.position.offset(0, 1, 0), true);
    bot.setControlState('left', side.x !== 0);
    bot.setControlState('right', side.z !== 0);
    bot.setControlState('sprint', true);
    await sleep(180);
  } catch (_) {}
  stopMotion(bot);
}

function start(bot, mcData, config, addInterval) {
  const cfg = config.combat || {};
  const advanced = cfg.advanced !== false;
  let lastAttack = 0;
  let target = null;
  let nextRetarget = 0;
  let recovering = false;

  const attackCooldown = Math.max(420, cfg.attackCooldownMs || 620);
  const range = Math.max(3, cfg.targetRange || 14);
  const lowHealth = Math.max(6, cfg.retreatHealth || 8);

  const tick = async () => {
    if (!bot?.entity || !cfg['attack-mobs']) return;
    if (bot.isSleeping) return;
    const now = Date.now();

    try {
      if (!target || now >= nextRetarget || !bot.entities[target.id]) {
        target = nearestThreat(bot, range);
        nextRetarget = now + 500;
      }
      if (!target) return;

      const dist = bot.entity.position.distanceTo(target.position);
      if (bot.health <= lowHealth) {
        await retreat(bot, target, 8);
        return;
      }

      if (bot.food < 12 && cfg['auto-eat']) {
        const food = chooseFood(bot, mcData);
        if (food) {
          try { await bot.equip(food, 'hand'); await bot.consume(); } catch (_) {}
          return;
        }
      }

      await equipWeapon(bot);

      // Knockback recovery: after a large velocity spike, stop the pathfinder,
      // regain footing and sidestep away before re-engaging.
      const v = bot.entity.velocity;
      const speed = v ? Math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z) : 0;
      if (advanced && speed > 0.75 && !recovering) {
        recovering = true;
        await sidestep(bot, target);
        setTimeout(() => { recovering = false; }, 300);
        return;
      }

      if (dist > 3.2) {
        await gotoPos(bot, target.position, 2.7, 4500);
      } else if (now - lastAttack >= attackCooldown) {
        try {
          await bot.lookAt(target.position.offset(0, Math.min(1.1, target.height || 1), 0), true);
          bot.attack(target);
          lastAttack = now;
        } catch (_) {}
      }
    } catch (e) {
      log('CombatAI', `Hata: ${e.message}`);
      target = null;
    }
  };

  const timer = addInterval(() => { tick().catch(() => {}); }, 180);

  bot.on('entityGone', entity => { if (target && entity.id === target.id) target = null; });
  bot.on('death', () => { target = null; stopMotion(bot); });
  bot.on('kicked', () => { target = null; });

  log('CombatAI', `Gelişmiş savaş sistemi aktif | hedef=${range} blok | knockback-recovery=true`);
  return timer;
}

module.exports = { start, nearestThreat, chooseWeapon };
