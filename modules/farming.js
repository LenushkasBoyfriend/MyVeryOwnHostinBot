'use strict';

const { log, gotoPos, findOneBlock, countItem, safePlace, sleep, Vec3 } = require('./utils');
const inv = require('./inventory');
const { loadState, saveState } = require('./state');

const FARM_CROPS = [
  { crop: 'wheat', seed: 'wheat_seeds', mature: b => b && b.name === 'wheat' && b.metadata >= 7 },
  { crop: 'carrots', seed: 'carrot', mature: b => b && b.name === 'carrots' && b.metadata >= 7 },
  { crop: 'potatoes', seed: 'potato', mature: b => b && b.name === 'potatoes' && b.metadata >= 7 },
  { crop: 'beetroot', seed: 'beetroot_seeds', mature: b => b && b.name === 'beetroots' && b.metadata >= 3 }
];

async function ensureHoe(bot, mcData) {
  const hoes = bot.inventory.items().filter(i => /_hoe$/.test(i.name));
  if (hoes.length) return hoes.sort((a, b) => (mcData.itemsByName[b.name]?.id || 0) - (mcData.itemsByName[a.name]?.id || 0))[0];
  const tiers = ['stone', 'wooden'];
  for (const tier of tiers) {
    if (await inv.craftItemByName(bot, mcData, `${tier}_hoe`, 1)) {
      return bot.inventory.items().find(i => i.name === `${tier}_hoe`) || null;
    }
  }
  return null;
}

function findSoil(bot, radius = 10) {
  const pos = bot.entity.position.floored();
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (const dy of [0, -1, 1]) {
        const p = pos.offset(dx, dy, dz);
        const block = bot.blockAt(p);
        if (!block || (block.name !== 'farmland' && block.name !== 'dirt' && block.name !== 'grass_block')) continue;
        const above = bot.blockAt(p.offset(0, 1, 0));
        if (above && ['air', 'cave_air'].includes(above.name)) return block;
      }
    }
  }
  return null;
}

async function makeFarmland(bot, soil, hoe) {
  if (!soil || !hoe) return false;
  try {
    await gotoPos(bot, soil.position, 2, 8000);
    await bot.equip(hoe, 'hand');
    await bot.activateBlock(soil);
    await sleep(250);
    return true;
  } catch (_) { return false; }
}

async function gatherSeeds(bot, mcData) {
  if (countItem(bot, 'wheat_seeds') > 0 || countItem(bot, 'carrot') > 0 || countItem(bot, 'potato') > 0 || countItem(bot, 'beetroot_seeds') > 0) return true;
  const grass = findOneBlock(bot, ['grass'], 18);
  if (!grass) return false;
  try {
    await gotoPos(bot, grass.position, 2, 6000);
    await bot.dig(grass, true);
    return true;
  } catch (_) { return false; }
}

async function plantSeed(bot, farmland, seedName) {
  const item = bot.inventory.items().find(i => i.name === seedName);
  if (!item || !farmland) return false;
  const above = bot.blockAt(farmland.position.offset(0, 1, 0));
  if (!above || !['air', 'cave_air'].includes(above.name)) return false;
  try {
    await gotoPos(bot, farmland.position, 2, 5000);
    await bot.equip(item, 'hand');
    await bot.placeBlock(farmland, new Vec3(0, 1, 0));
    await sleep(200);
    return true;
  } catch (_) { return false; }
}

async function harvest(bot, cropDef) {
  let harvested = 0;
  const pos = bot.entity.position.floored();
  for (let dx = -10; dx <= 10; dx++) {
    for (let dz = -10; dz <= 10; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const block = bot.blockAt(pos.offset(dx, dy, dz));
        if (!cropDef.mature(block)) continue;
        try {
          await gotoPos(bot, block.position, 2, 5000);
          await bot.dig(block, true);
          harvested += 1;
        } catch (_) {}
      }
    }
  }
  return harvested;
}

async function runFarmCycle(bot, mcData, cfg = {}) {
  const state = loadState();
  const hoe = await ensureHoe(bot, mcData);
  if (!hoe) return { success: false, reason: 'no-hoe' };
  await gatherSeeds(bot, mcData);

  const preferred = cfg.preferredCrop || 'wheat';
  const cropDef = FARM_CROPS.find(c => c.crop === preferred) || FARM_CROPS[0];
  const harvested = await harvest(bot, cropDef);

  let farmland = findSoil(bot, cfg.radius || 10);
  if (!farmland) {
    const soil = findSoil(bot, 18);
    if (soil) {
      await makeFarmland(bot, soil, hoe);
      farmland = bot.blockAt(soil.position);
    }
  }

  let planted = 0;
  if (farmland && farmland.name === 'farmland') {
    const around = farmland.position;
    const candidates = [around, around.offset(1, 0, 0), around.offset(-1, 0, 0), around.offset(0, 0, 1), around.offset(0, 0, -1)];
    for (const p of candidates) {
      const f = bot.blockAt(p);
      if (f && f.name === 'farmland' && await plantSeed(bot, f, cropDef.seed)) planted += 1;
    }
  }

  state.hasFarm = !!(harvested > 0 || planted > 0 || (farmland && farmland.name === 'farmland'));
  state.farm = { crop: cropDef.crop, lastRun: Date.now(), harvested, planted };
  saveState(state);
  log('Farming', `Tarım döngüsü: ${harvested} hasat, ${planted} ekim.`);
  return { success: state.hasFarm, harvested, planted };
}

module.exports = { ensureHoe, runFarmCycle, gatherSeeds, harvest };
