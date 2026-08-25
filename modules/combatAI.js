'use strict';

const { gotoPos, sleep, countItem, stopMotion, log, Vec3 } = require('./utils');

const HOSTILES = new Set([
  'zombie','husk','drowned','skeleton','stray','bogged','creeper','spider','cave_spider',
  'witch','pillager','vindicator','evoker','ravager','phantom','slime','magma_cube',
  'enderman','silverfish','endermite','blaze','ghast','piglin_brute','hoglin','zoglin',
  'warden','breeze'
]);

function nearestThreat(bot, radius) {
  return Object.values(bot.entities || {})
    .filter(e => e && e.position && e.type !== 'player' && HOSTILES.has(e.name))
    .filter(e => bot.entity.position.distanceTo(e.position) <= radius)
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0] || null;
}

function chooseWeapon(bot) {
  const weapons = bot.inventory.items().filter(i => /_(sword|axe)$/.test(i.name));
  weapons.sort((a, b) => {
    const rank = n => /netherite/.test(n) ? 5 : /diamond/.test(n) ? 4 : /iron/.test(n) ? 3 : /stone/.test(n) ? 2 : 1;
    return rank(b.name) - rank(a.name);
  });
  return weapons[0] || null;
}

function chooseFood(bot, mcData) {
  return bot.inventory.items().find(i => {
    const f = mcData.foods && Object.values(mcData.foods).find(x => x.id === i.type);
    return f && f.foodPoints > 0;
  }) || null;
}

async function equipWeapon(bot) {
  const w = chooseWeapon(bot);
  if (w && bot.equip) {
    try { await bot.equip(w, 'hand'); } catch (_) {}
  }
  return w;
}

async function retreat(bot, target, distance = 8) {
  if (!bot?.entity || !target?.position) return false;
  const away = bot.entity.position.minus(target.position);
  const len = Math.max(0.01, Math.hypot(away.x, away.z));
  const targetPos = bot.entity.position.plus(new Vec3((away.x / len) * distance, 0, (away.z / len) * distance));
  return gotoPos(bot, targetPos, 1.5, 5000);
}

function start(bot, mcData, config, addInterval) {
  const cfg = config.combat || {};
  const range = Math.max(4, cfg.targetRange || 14);
  const attackCooldown = Math.max(450, cfg.attackCooldownMs || 620);
  const retreatHealth = Math.max(5, cfg.retreatHealth || 8);
  let target = null;
  let lastAttack = 0;
  let active = false;

  const tick = async () => {
    if (!bot?.entity || !cfg['attack-mobs'] || bot.isSleeping || active) return;
    target = target && bot.entities[target.id] ? bot.entities[target.id] : nearestThreat(bot, range);
    if (!target) return;

    // Don't rip the pathfinder goal away from a mid-task SurvivalAI run for a
    // distant mob - that "two brains fighting over movement" is exactly what
    // caused earlier versions of this bot to get permanently stuck. Only
    // preempt when there's a real, close emergency or health is already low.
    const distNow = bot.entity.position.distanceTo(target.position);
    if (bot.__autonomyBusy && bot.health > retreatHealth + 4 && distNow > 6) return;

    active = true;
    bot.__autonomyBusy = true;
    try {
      if (bot.health <= retreatHealth) {
        await retreat(bot, target, 8);
        return;
      }
      if (cfg['auto-eat'] && bot.food < 12) {
        const food = chooseFood(bot, mcData);
        if (food && bot.consume) {
          try { await bot.equip(food, 'hand'); await bot.consume(); } catch (_) {}
          return;
        }
      }

      await equipWeapon(bot);
      const dist = bot.entity.position.distanceTo(target.position);
      if (dist > 3.4) {
        await gotoPos(bot, target.position, 2.8, 4500);
      } else if (Date.now() - lastAttack >= attackCooldown) {
        await bot.lookAt(target.position.offset(0, Math.min(1.2, target.height || 1), 0), true);
        bot.attack(target);
        lastAttack = Date.now();
      }
    } catch (e) {
      log('CombatAI', `Hata: ${e.message}`);
      target = null;
    } finally {
      bot.__autonomyBusy = false;
      active = false;
    }
  };

  addInterval(() => tick().catch(() => {}), 220);
  bot.on('entityGone', entity => { if (target && entity.id === target.id) target = null; });
  bot.on('death', () => { target = null; stopMotion(bot); });
  bot.on('kicked', () => { target = null; });

  log('CombatAI', `Hostile-only combat active | range=${range} | direct movement disabled`);
}

module.exports = { start, nearestThreat, chooseWeapon };
