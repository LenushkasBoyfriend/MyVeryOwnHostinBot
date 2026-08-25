'use strict';

const { Vec3, gotoPos, safeDig, countItem, sleep, log } = require('./utils');
const { ORE_GROUPS } = require('./gathering');

const AIR = new Set(['air', 'cave_air', 'void_air']);
const HAZARD = /lava|fire|campfire|soul_fire/;

const ORE_VALUE = {
  diamond_ore: 100, deepslate_diamond_ore: 100,
  ancient_debris: 120,
  gold_ore: 55, deepslate_gold_ore: 55,
  redstone_ore: 40, deepslate_redstone_ore: 40,
  lapis_ore: 35, deepslate_lapis_ore: 35,
  iron_ore: 30, deepslate_iron_ore: 30,
  coal_ore: 12, deepslate_coal_ore: 12,
  emerald_ore: 70, deepslate_emerald_ore: 70
};
const SOFT_ORE = new Set(Object.values(ORE_GROUPS).flat().concat(['ancient_debris']));

function blockIsAir(block) { return !block || AIR.has(block.name); }
function blockIsSolid(block) { return !!block && !AIR.has(block.name) && block.boundingBox === 'block'; }

function bestPickaxe(bot) {
  return bot.inventory.items()
    .filter(i => /_(pickaxe)$/.test(i.name))
    .sort((a, b) => {
      const rank = n => /netherite/.test(n) ? 5 : /diamond/.test(n) ? 4 : /iron/.test(n) ? 3 : /stone/.test(n) ? 2 : /gold/.test(n) ? 2 : 1;
      return rank(b.name) - rank(a.name);
    })[0] || null;
}

function lowDurability(item, threshold = 32) {
  if (!item || !item.maxDurability) return false;
  const remaining = item.maxDurability - (item.durabilityUsed || 0);
  return remaining <= threshold;
}

function nearbyHazard(bot, pos, radius = 2) {
  for (let x = -radius; x <= radius; x++) {
    for (let y = -1; y <= 2; y++) {
      for (let z = -radius; z <= radius; z++) {
        const b = bot.blockAt(new Vec3(pos.x + x, pos.y + y, pos.z + z));
        if (HAZARD.test(b?.name || '')) return true;
      }
    }
  }
  return false;
}

function canOccupy(bot, pos) {
  const foot = bot.blockAt(pos);
  const head = bot.blockAt(pos.offset(0, 1, 0));
  const below = bot.blockAt(pos.offset(0, -1, 0));
  return blockIsAir(foot) && blockIsAir(head) && blockIsSolid(below) && !nearbyHazard(bot, pos, 2);
}

async function safeStep(bot, pos) {
  if (!canOccupy(bot, pos)) return false;
  return gotoPos(bot, pos, 0, 4500);
}

function visibleOrePositions(bot, oreNames, radius = 20) {
  const found = bot.findBlocks({
    matching: b => !!b && oreNames.includes(b.name),
    maxDistance: radius,
    count: 40
  }) || [];
  return found.map(p => bot.blockAt(p)).filter(Boolean)
    .sort((a, b) => {
      const va = ORE_VALUE[a.name] || 1, vb = ORE_VALUE[b.name] || 1;
      const da = bot.entity.position.distanceTo(a.position), db = bot.entity.position.distanceTo(b.position);
      return (vb - va) * 4 + da - db;
    });
}

async function collectVisibleVein(bot, oreNames, maxBlocks = 16) {
  let mined = 0;
  const seen = new Set();
  while (mined < maxBlocks) {
    const candidates = visibleOrePositions(bot, oreNames, 20);
    const block = candidates.find(b => !seen.has(`${b.position.x},${b.position.y},${b.position.z}`));
    if (!block) break;
    const key = `${block.position.x},${block.position.y},${block.position.z}`;
    seen.add(key);
    if (nearbyHazard(bot, block.position, 3)) {
      log('MiningAI', `Tehlike yakınındaki cevher atlandı: ${block.name}`);
      continue;
    }
    if (await safeDig(bot, block)) mined++;
    await sleep(100);
  }
  return mined;
}

async function craftTorches(bot, mcData, minCount = 32) {
  if (countItem(bot, 'torch') >= minCount) return true;
  try {
    const inv = require('./inventory');
    const table = await inv.ensureCraftingTable(bot, mcData);
    if (!table) return false;
    await inv.craftAnyItem(bot, mcData, 'torch', minCount, { maxDepth: 6, table });
  } catch (_) {}
  return countItem(bot, 'torch') >= minCount;
}

function chooseDirection(bot, current, dir) {
  const dirs = [
    new Vec3(1,0,0), new Vec3(-1,0,0),
    new Vec3(0,0,1), new Vec3(0,0,-1)
  ].filter(d => !(d.x === -dir.x && d.z === -dir.z));
  return dirs
    .map(d => ({ d, score: canOccupy(bot, current.plus(d)) ? Math.random() + 2 : Math.random() }))
    .sort((a,b) => b.score-a.score)[0]?.d || dir;
}

async function branchMine(bot, mcData, options = {}) {
  const cfg = {
    targetY: options.targetY ?? options.shaftYLevel ?? -58,
    maxSteps: options.maxSteps ?? 420,
    targetCount: options.targetCount ?? 20,
    torchInterval: options.torchInterval ?? 6,
    scanRadius: options.scanRadius ?? 20,
    ...(options || {})
  };
  const ores = Array.from(new Set([
    ...(cfg.ores || ORE_GROUPS.diamond),
    ...(cfg.includeIron ? ORE_GROUPS.iron : []),
    ...(cfg.includeCoal ? ORE_GROUPS.coal : []),
    ...(cfg.includeGold ? ORE_GROUPS.gold : []),
    ...(cfg.includeLapis ? ORE_GROUPS.lapis : []),
    ...(cfg.includeRedstone ? ORE_GROUPS.redstone : [])
  ]));
  const startY = Math.floor(bot.entity.position.y);
  let mined = 0, steps = 0, corridorSteps = 0, torchCounter = 0;
  let dir = Math.random() < 0.5 ? new Vec3(1,0,0) : new Vec3(0,0,1);
  const pick = bestPickaxe(bot);

  if (!pick) return { mined, reason: 'no-pickaxe' };
  if (lowDurability(pick, 18)) return { mined, reason: 'pickaxe-low-durability' };
  await craftTorches(bot, mcData, 32);

  // Do not blindly dig down. Prefer a safe path to a nearby target level.
  while (Math.floor(bot.entity.position.y) > cfg.targetY + 1 && steps++ < 80) {
    const current = bot.entity.position.floored();
    const down = current.offset(0, -1, 0);
    if (nearbyHazard(bot, down, 3)) break;
    const below = bot.blockAt(down);
    if (blockIsSolid(below) && !HAZARD.test(below.name)) {
      // Only clear a single block when the destination cell is actually safe.
      const destination = current.offset(0, -1, 0);
      const head = bot.blockAt(destination);
      const head2 = bot.blockAt(destination.offset(0,1,0));
      if (blockIsSolid(head) && !HAZARD.test(head.name)) await safeDig(bot, head);
      if (blockIsSolid(head2) && !HAZARD.test(head2.name)) await safeDig(bot, head2);
    }
    const moved = await gotoPos(bot, current.offset(0,-1,0), 0, 5000);
    if (!moved) break;
  }

  while (steps++ < cfg.maxSteps && mined < cfg.targetCount) {
    const current = bot.entity.position.floored();

    // First exploit exposed veins instead of blindly extending the tunnel.
    const visible = await collectVisibleVein(bot, ores, Math.min(12, cfg.targetCount - mined));
    mined += visible;
    if (mined >= cfg.targetCount) break;

    if (nearbyHazard(bot, current, cfg.avoidLavaRadius || 3)) {
      dir = chooseDirection(bot, current, dir);
      continue;
    }

    const front = current.plus(dir);
    const foot = bot.blockAt(front);
    const head = bot.blockAt(front.offset(0,1,0));

    // If an ore is behind one block, expose it, but never open a cavity into lava.
    const frontOre = [foot, head].find(b => b && ores.includes(b.name));
    if (frontOre && !nearbyHazard(bot, frontOre.position, 3)) {
      if (await safeDig(bot, frontOre)) mined++;
      continue;
    }

    if (HAZARD.test(foot?.name || '') || HAZARD.test(head?.name || '')) {
      dir = chooseDirection(bot, current, dir);
      continue;
    }

    if (!blockIsAir(foot)) {
      if (!(await safeDig(bot, foot))) { dir = chooseDirection(bot, current, dir); continue; }
    }
    if (!blockIsAir(head)) {
      if (!(await safeDig(bot, head))) { dir = chooseDirection(bot, current, dir); continue; }
    }

    if (!(await safeStep(bot, front))) {
      const next = chooseDirection(bot, current, dir);
      if (next.x === dir.x && next.z === dir.z) break;
      dir = next;
      continue;
    }

    corridorSteps++;
    torchCounter++;
    if (torchCounter >= cfg.torchInterval && countItem(bot, 'torch') > 0) {
      const u = require('./utils');
      const below = bot.blockAt(bot.entity.position.offset(0,-1,0));
      if (below?.boundingBox === 'block') {
        try { await u.safePlace(bot, 'torch', below, new Vec3(0,1,0)); } catch (_) {}
      }
      torchCounter = 0;
    }

    if (corridorSteps % 10 === 0) {
      dir = chooseDirection(bot, bot.entity.position.floored(), dir);
    }
    await sleep(90);
  }

  return {
    mined, steps, y: Math.floor(bot.entity.position.y),
    targetY: cfg.targetY, pickaxe: pick.name,
    ores: ores.filter(n => SOFT_ORE.has(n))
  };
}

module.exports = {
  branchMine, collectVisibleVein, craftTorches, lowDurability, nearbyHazard
};
