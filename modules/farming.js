'use strict';
// Basit çiftçilik: toprağı sürer, tohum eker, olgun ürünü hasat eder ve yeniden eker.
// Amaç mükemmel bir farm otomasyonu değil; gerçek bir oyuncunun yapacağı gibi
// küçük, tekrarlanabilir bir tarla döngüsü kurmak.

const { log, gotoPos, gotoBlock, findOneBlock, safeDig, safePlace, countItem, sleep, Vec3 } = require('./utils');

const CROPS = {
  wheat: { seed: 'wheat_seeds', crop: 'wheat', matureAge: 7 },
  carrot: { seed: 'carrot', crop: 'carrots', matureAge: 7 },
  potato: { seed: 'potato', crop: 'potatoes', matureAge: 7 }
};

function cropInfo(name) {
  return CROPS[name] || CROPS.wheat;
}

// Elde hoe yoksa, ağaçtan alınmış tahtayla bir tane üretmeye çalışır.
async function ensureHoe(bot, mcData) {
  if (bot.inventory.items().some(i => /_hoe$/.test(i.name))) return true;
  const inv = require('./inventory');
  await inv.convertLogsToPlanks(bot, mcData);
  await inv.ensureSticks(bot, mcData, 2);
  const table = await inv.ensureCraftingTable(bot, mcData);
  if (!table) return false;
  // Önce ahşap, olmazsa taş baltayla dener.
  const tryOrder = ['wooden_hoe', 'stone_hoe'];
  for (const name of tryOrder) {
    const data = mcData.itemsByName[name];
    if (!data) continue;
    const recipes = bot.recipesFor(data.id, null, 1, table);
    if (!recipes.length) continue;
    try {
      await bot.craft(recipes[0], 1, table);
      return true;
    } catch (e) { /* dene sıradaki malzeme */ }
  }
  return false;
}

// Yakında yeterince açık, sulanmış (su kaynağına yakın) çim/toprak var mı diye bakar.
function findWaterSource(bot, maxDistance = 24) {
  return findOneBlock(bot, ['water'], maxDistance);
}

// Su kaynağının etrafındaki, ekilebilir (grass/dirt) blokları toprak haline getirir.
async function tillPlotAroundWater(bot, mcData, plotSize = 5) {
  const waterPos = findWaterSource(bot, 32);
  if (!waterPos) return null;

  const hoe = bot.inventory.items().find(i => /_hoe$/.test(i.name));
  if (!hoe) return null;

  const half = Math.floor(plotSize / 2);
  let tilled = 0;
  for (let dx = -half; dx <= half; dx++) {
    for (let dz = -half; dz <= half; dz++) {
      const pos = waterPos.offset(dx, 0, dz);
      const block = bot.blockAt(pos);
      if (!block || (block.name !== 'grass_block' && block.name !== 'dirt')) continue;
      const above = bot.blockAt(pos.offset(0, 1, 0));
      if (!above || above.name !== 'air') continue;
      try {
        if (bot.entity.position.distanceTo(pos) > 4) await gotoPos(bot, pos, 3, 8000);
        await bot.equip(hoe, 'hand');
        await bot.activateBlock(block);
        tilled++;
        await sleep(150);
      } catch (e) {
        // Bir blok başarısız olursa devam et, tüm işi iptal etme.
      }
    }
  }
  return tilled > 0 ? waterPos : null;
}

// Olgunlaşmış ürünleri hasat edip aynı yere yeniden tohum eker.
async function harvestAndReplant(bot, mcData, cropName = 'wheat') {
  const info = cropInfo(cropName);
  let harvested = 0;
  let attempts = 0;

  while (attempts < 30) {
    attempts++;
    const pos = bot.findBlock({
      matching: (b) => b && b.name === info.crop && b.metadata === info.matureAge,
      maxDistance: 24
    });
    if (!pos) break;
    const block = bot.blockAt(pos);
    try {
      if (bot.entity.position.distanceTo(pos) > 4) await gotoPos(bot, pos, 3, 8000);
      await bot.dig(block);
      harvested++;
      await sleep(150);
      // Aynı toprağa hemen yeniden tohum ek (elinde tohum varsa).
      const seed = bot.inventory.items().find(i => i.name === info.seed);
      const farmland = bot.blockAt(pos.offset(0, -1, 0));
      if (seed && farmland && farmland.name === 'farmland') {
        try {
          await bot.equip(seed, 'hand');
          await bot.placeBlock(farmland, new Vec3(0, 1, 0));
        } catch (e) { /* tohum ekilemedi, sorun değil, sıradaki tarlaya geç */ }
      }
    } catch (e) {
      log('Farming', `Hasat hatası: ${e.message}`);
    }
  }
  return harvested;
}

// Boş (tohum atılmamış) farmland karelerine tohum eker.
async function plantEmptyFarmland(bot, mcData, cropName = 'wheat') {
  const info = cropInfo(cropName);
  let planted = 0;
  let attempts = 0;

  const seed = () => bot.inventory.items().find(i => i.name === info.seed);
  if (!seed()) return 0;

  while (attempts < 20 && seed()) {
    attempts++;
    const pos = bot.findBlock({
      matching: (b) => b && b.name === 'farmland',
      maxDistance: 24
    });
    if (!pos) break;
    const above = bot.blockAt(pos.offset(0, 1, 0));
    if (above && above.name !== 'air') continue;
    try {
      if (bot.entity.position.distanceTo(pos) > 4) await gotoPos(bot, pos, 3, 8000);
      const farmland = bot.blockAt(pos);
      await bot.equip(seed(), 'hand');
      await bot.placeBlock(farmland, new Vec3(0, 1, 0));
      planted++;
      await sleep(150);
    } catch (e) {
      // bu kare olmadıysa devam
    }
  }
  return planted;
}

// Buğday tohumu yoksa, kısa çim bloklarını kırarak tohum edinmeye çalışır
// (vanilla Minecraft'ta gerçek oyuncular da tohumu böyle edinir).
async function gatherSeedsFromGrass(bot, mcData, attempts = 12) {
  let collected = 0;
  for (let i = 0; i < attempts; i++) {
    const pos = bot.findBlock({
      matching: (b) => b && (b.name === 'short_grass' || b.name === 'grass' || b.name === 'tall_grass'),
      maxDistance: 20
    });
    if (!pos) break;
    const block = bot.blockAt(pos);
    try {
      if (bot.entity.position.distanceTo(pos) > 4) await gotoPos(bot, pos, 3, 6000);
      await bot.dig(block);
      collected++;
      await sleep(120);
      if (bot.inventory.items().some(i => i.name === 'wheat_seeds')) break;
    } catch (e) {
      break;
    }
  }
  return collected;
}

// Bir çiftçilik döngüsü: tarla yoksa kur, olgun ürünü hasat et, boş kareleri ek.
async function runFarmCycle(bot, mcData, cfg = {}) {
  const cropName = cfg.crop || 'wheat';
  const plotSize = cfg.plotSize || 5;
  const info = cropInfo(cropName);

  if (!bot.inventory.items().some(i => i.name === info.seed) && cropName === 'wheat') {
    await gatherSeedsFromGrass(bot, mcData);
  }

  let existingFarmland = bot.findBlock({ matching: (b) => b && b.name === 'farmland', maxDistance: 24 });
  let tilled = false;
  if (!existingFarmland) {
    await ensureHoe(bot, mcData);
    const water = await tillPlotAroundWater(bot, mcData, plotSize);
    tilled = !!water;
  }

  const harvested = await harvestAndReplant(bot, mcData, cropName);
  const planted = await plantEmptyFarmland(bot, mcData, cropName);

  return { harvested, planted, tilled, hasFarm: tilled || !!existingFarmland };
}

module.exports = {
  CROPS,
  cropInfo,
  ensureHoe,
  tillPlotAroundWater,
  harvestAndReplant,
  plantEmptyFarmland,
  runFarmCycle
};
