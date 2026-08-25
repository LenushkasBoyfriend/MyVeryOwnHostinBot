'use strict';
// Üretim (crafting), fırın (smelting) ve ekipman seviyesi yardımcıları.

const { log, gotoBlock, findOneBlock, countItem, sleep, safePlace, Vec3 } = require('./utils');

const TIERS = ['wooden', 'stone', 'iron', 'diamond'];
const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'sword'];
const ARMOR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];

function tierIndex(tier) {
  return TIERS.indexOf(tier);
}

// Bottaki en iyi (en yüksek seviyeli) alete göre "gear tier" döner.
function currentToolTier(bot) {
  let best = -1;
  for (const item of bot.inventory.items()) {
    for (let i = TIERS.length - 1; i >= 0; i--) {
      if (item.name === `${TIERS[i]}_pickaxe`) {
        if (i > best) best = i;
      }
    }
  }
  return best >= 0 ? TIERS[best] : null;
}

function hasFullToolSet(bot, tier) {
  return TOOL_KINDS.every(kind => countItem(bot, `${tier}_${kind}`) >= 1);
}

function hasFullArmorSet(bot, tier) {
  if (tier === 'wooden' || tier === 'stone') return true; // ahşap/taş zırh gerçekte yok, atla
  return ARMOR_PIECES.every(piece => countItem(bot, `${tier}_${piece}`) >= 1);
}

// Elimizdeki tüm kütükleri (log) tahtaya (planks) çevirir.
async function convertLogsToPlanks(bot, mcData) {
  const logs = bot.inventory.items().filter(i => /_log$/.test(i.name) || /_stem$/.test(i.name) || /_hyphae$/.test(i.name));
  for (const logItem of logs) {
    const planksName = logItem.name.replace(/_log$/, '_planks').replace(/_stem$/, '_planks').replace(/_hyphae$/, '_planks');
    const planksData = mcData.itemsByName[planksName];
    if (!planksData) continue;
    const recipes = bot.recipesFor(planksData.id, null, 1, null);
    if (!recipes.length) continue;
    try {
      await bot.craft(recipes[0], logItem.count, null);
    } catch (e) {
      log('Craft', `Tahta üretim hatası: ${e.message}`);
    }
  }
}

async function ensureSticks(bot, mcData, minCount = 4) {
  if (countItem(bot, 'stick') >= minCount) return true;
  const stickData = mcData.itemsByName['stick'];
  const recipes = bot.recipesFor(stickData.id, null, 1, null);
  if (!recipes.length) return false;
  try {
    const need = Math.ceil((minCount - countItem(bot, 'stick')) / recipes[0].result.count);
    await bot.craft(recipes[0], Math.max(1, need), null);
    return true;
  } catch (e) {
    log('Craft', `Değnek üretim hatası: ${e.message}`);
    return false;
  }
}

// Yakında bir crafting table bulur, yoksa elindekini yerleştirir, o da yoksa
// tahta biriktirip yenisini üretir. Sonuçta table Block referansı döner.
async function ensureCraftingTable(bot, mcData) {
  let table = findOneBlock(bot, ['crafting_table'], 24);
  if (table) return table;

  let item = bot.inventory.items().find(i => i.name === 'crafting_table');
  if (!item) {
    await convertLogsToPlanks(bot, mcData);
    const planksData = mcData.itemsByName['crafting_table'];
    const recipes = bot.recipesFor(planksData.id, null, 1, null);
    if (recipes.length && countItem(bot, i => /_planks$/.test(i.name)) >= 4) {
      try { await bot.craft(recipes[0], 1, null); } catch (e) { log('Craft', `Tezgah üretim hatası: ${e.message}`); }
    }
    item = bot.inventory.items().find(i => i.name === 'crafting_table');
  }
  if (!item) return null;

  const refBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  const placed = await safePlace(bot, 'crafting_table', refBlock, new Vec3(0, 1, 0));
  if (!placed) return null;
  await sleep(300);
  table = findOneBlock(bot, ['crafting_table'], 8);
  return table;
}

async function ensureFurnace(bot, mcData) {
  let furnace = findOneBlock(bot, ['furnace'], 24);
  if (furnace) return furnace;

  let item = bot.inventory.items().find(i => i.name === 'furnace');
  if (!item) {
    if (countItem(bot, i => /cobblestone|cobbled_deepslate/.test(i.name)) < 8) return null;
    const table = await ensureCraftingTable(bot, mcData);
    if (!table) return null;
    await gotoBlock(bot, table, 2);
    const furnaceData = mcData.itemsByName['furnace'];
    const recipes = bot.recipesFor(furnaceData.id, null, 1, table);
    if (!recipes.length) return null;
    try { await bot.craft(recipes[0], 1, table); } catch (e) { log('Craft', `Fırın üretim hatası: ${e.message}`); return null; }
    item = bot.inventory.items().find(i => i.name === 'furnace');
  }
  if (!item) return null;

  const refBlock = bot.blockAt(bot.entity.position.offset(1, -1, 0));
  const placed = await safePlace(bot, 'furnace', refBlock, new Vec3(0, 1, 0));
  if (!placed) return null;
  await sleep(300);
  furnace = findOneBlock(bot, ['furnace'], 8);
  return furnace;
}

// Verilen ismi, gereken malzemeleri elden geldiğince önce üretmeye çalışarak (planks -> sticks)
// crafting table kullanarak üretir.
async function craftItemByName(bot, mcData, itemName, count, table) {
  const data = mcData.itemsByName[itemName];
  if (!data) return false;
  const recipes = bot.recipesFor(data.id, null, 1, table || null);
  if (!recipes.length) return false;
  const recipe = recipes[0];
  const craftsNeeded = Math.max(1, Math.ceil(count / (recipe.result.count || 1)));
  try {
    if (table) await gotoBlock(bot, table, 2);
    await bot.craft(recipe, craftsNeeded, table || null);
    return true;
  } catch (e) {
    log('Craft', `${itemName} üretim hatası: ${e.message}`);
    return false;
  }
}

// Belirli bir tier (wooden/stone/iron/diamond) için tüm alet setini üretir.
async function craftToolTier(bot, mcData, tier) {
  await convertLogsToPlanks(bot, mcData);
  await ensureSticks(bot, mcData, 8);
  const table = await ensureCraftingTable(bot, mcData);
  if (!table) return false;
  let anyMade = false;
  for (const kind of TOOL_KINDS) {
    const name = `${tier}_${kind}`;
    if (countItem(bot, name) >= 1) continue;
    const ok = await craftItemByName(bot, mcData, name, 1, table);
    if (ok) anyMade = true;
    await sleep(200);
  }
  return anyMade;
}

async function craftArmorTier(bot, mcData, tier) {
  if (tier === 'wooden' || tier === 'stone') return false; // gerçek oyunda yok
  const table = await ensureCraftingTable(bot, mcData);
  if (!table) return false;
  let anyMade = false;
  for (const piece of ARMOR_PIECES) {
    const name = `${tier}_${piece}`;
    if (countItem(bot, name) >= 1) continue;
    const ok = await craftItemByName(bot, mcData, name, 1, table);
    if (ok) anyMade = true;
    await sleep(200);
  }
  return anyMade;
}

// Fırında cevheri eritir (ör: iron_ore -> iron_ingot). fuelName yoksa kömür/odun otomatik seçilir.
async function smeltItems(bot, mcData, oreName, resultCount) {
  const furnace = await ensureFurnace(bot, mcData);
  if (!furnace) return false;
  await gotoBlock(bot, furnace, 2);

  const ore = bot.inventory.items().find(i => i.name === oreName);
  if (!ore) return false;

  const fuelItem = bot.inventory.items().find(i =>
    i.name === 'coal' || i.name === 'charcoal' || /_planks$/.test(i.name) || /_log$/.test(i.name)
  );

  try {
    const win = await bot.openFurnace(furnace);
    if (fuelItem) await win.putFuel(fuelItem.type, null, Math.min(fuelItem.count, 8));
    await win.putInput(ore.type, null, Math.min(ore.count, resultCount || ore.count));

    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 45000);
      win.on('update', () => {
        if (win.outputItem() && win.outputItem().count >= (resultCount || 1)) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    if (win.outputItem()) {
      await win.takeOutput();
    }
    win.close();
    return true;
  } catch (e) {
    log('Smelt', `Hata: ${e.message}`);
    try { furnaceWinClose(); } catch (err) { }
    return false;
  }
}

function furnaceWinClose() { /* no-op placeholder for symmetry */ }

module.exports = {
  TIERS,
  TOOL_KINDS,
  ARMOR_PIECES,
  tierIndex,
  currentToolTier,
  hasFullToolSet,
  hasFullArmorSet,
  convertLogsToPlanks,
  ensureSticks,
  ensureCraftingTable,
  ensureFurnace,
  craftItemByName,
  craftToolTier,
  craftArmorTier,
  smeltItems
};

// Genel amaçlı, tarif grafiğini takip eden craft yardımcısı.
// Önce mevcut bot tariflerini kullanır; eksik ara ürünler varsa mcData tariflerinden
// olası üretim yolunu arayıp ara ürünleri de sırayla üretmeyi dener.
function buildRecipeGraph(mcData) {
  const graph = {};
  const recipes = Array.isArray(mcData?.recipes) ? mcData.recipes : [];
  for (const recipe of recipes) {
    const resultId = recipe.result?.id ?? recipe.result?.item ?? recipe.result?.type;
    if (resultId == null) continue;
    const result = mcData.items?.[resultId] || mcData.itemsArray?.find(i => i.id === resultId);
    if (!result?.name) continue;
    const ingredients = [];
    const raw = recipe.ingredients || recipe.ingredient || [];
    for (const ing of raw) {
      if (Array.isArray(ing)) {
        const ids = ing.map(x => typeof x === 'number' ? x : x?.id).filter(Boolean);
        const pick = ids.length ? ids[0] : null;
        const item = pick ? (mcData.items?.[pick] || mcData.itemsArray?.find(i => i.id === pick)) : null;
        if (item?.name) ingredients.push(item.name);
      } else {
        const id = typeof ing === 'number' ? ing : ing?.id;
        const item = id ? (mcData.items?.[id] || mcData.itemsArray?.find(i => i.id === id)) : null;
        if (item?.name) ingredients.push(item.name);
      }
    }
    if (!graph[result.name]) graph[result.name] = [];
    graph[result.name].push({ recipe, ingredients });
  }
  return graph;
}

async function craftAnyItem(bot, mcData, itemName, count = 1, options = {}) {
  const maxDepth = options.maxDepth || 5;
  const visiting = options.visiting || new Set();
  if (countItem(bot, itemName) >= count) return true;
  if (visiting.has(itemName) || maxDepth <= 0) return false;
  visiting.add(itemName);

  const data = mcData.itemsByName[itemName];
  if (!data) { visiting.delete(itemName); return false; }

  let recipes = bot.recipesFor(data.id, null, 1, options.table || null);
  if (recipes.length) {
    const ok = await craftItemByName(bot, mcData, itemName, count, options.table || null);
    visiting.delete(itemName);
    return ok || countItem(bot, itemName) >= count;
  }

  const graph = buildRecipeGraph(mcData);
  const candidates = graph[itemName] || [];
  for (const candidate of candidates) {
    let possible = true;
    for (const ing of candidate.ingredients) {
      if (countItem(bot, ing) > 0) continue;
      // Recursive production is deliberately shallow to avoid loops.
      if (!(await craftAnyItem(bot, mcData, ing, 1, { ...options, maxDepth: maxDepth - 1, visiting }))) {
        possible = false;
        break;
      }
    }
    if (!possible) continue;
    recipes = bot.recipesFor(data.id, null, 1, options.table || null);
    if (recipes.length) {
      const ok = await craftItemByName(bot, mcData, itemName, count, options.table || null);
      visiting.delete(itemName);
      return ok || countItem(bot, itemName) >= count;
    }
  }
  visiting.delete(itemName);
  return false;
}

module.exports.craftAnyItem = craftAnyItem;
module.exports.buildRecipeGraph = buildRecipeGraph;

function getRecipeKnowledge(mcData) {
  const graph = buildRecipeGraph(mcData);
  const result = {};
  for (const item of (mcData?.itemsArray || [])) {
    const recipes = graph[item.name] || [];
    result[item.name] = {
      craftable: recipes.length > 0,
      recipeCount: recipes.length,
      ingredients: recipes[0]?.ingredients || [],
      methods: recipes.length ? ['craft'] : ['learn-or-explore']
    };
  }
  return result;
}
module.exports.getRecipeKnowledge = getRecipeKnowledge;
