
'use strict';
const { log, gotoBlock, gotoPos, findNearestBlock, safeDig, countItem, sleep, randInt, Vec3 } = require('./utils');
const LOG_MATCH = name => /_log$/.test(name) || /_stem$/.test(name) || /_hyphae$/.test(name);
const STONE_LIKE = ['stone','andesite','diorite','granite','deepslate','cobbled_deepslate','tuff'];

async function digTrackingType(bot, block) {
  if (!block || !bot?.entity) return null;
  const originalName = block.name;
  try {
    // Never walk to the position of a block after breaking it: that position is
    // now air and doing so caused several-second Pathfinder stalls per log.
    if (bot.entity.position.distanceTo(block.position) > 3.2) {
      const ok = await gotoPos(bot, block.position, 2.6, 4500);
      if (!ok) return null;
    }
    const ok = await safeDig(bot, block);
    return ok ? originalName : null;
  } catch (_) {
    return null;
  }
}

async function wanderForTarget(bot, predicate, maxDistance = 64) {
  const start = bot.entity.position.clone();
  for (let i=0; i<5; i++) {
    const found = bot.findBlock({ matching: b => b && predicate(b), maxDistance });
    if (found) return bot.blockAt(found);
    const target = start.offset(randInt(-14,14), 0, randInt(-14,14));
    await gotoPos(bot, target, 2, 8000);
    await sleep(200);
  }
  return null;
}

async function gatherWood(bot, mcData, target = 24) {
  let attempts = 0;
  const maxAttempts = Math.max(30, target * 5);
  while (countItem(bot, i => LOG_MATCH(i.name)) < target && attempts++ < maxAttempts) {
    let pos = bot.findBlock({ matching: b => b && LOG_MATCH(b.name), maxDistance: 32 });
    if (!pos) {
      const moved = await wanderForTarget(bot, b => LOG_MATCH(b.name), 64);
      if (!moved) continue;
      pos = moved.position;
    }

    let block = bot.blockAt(pos);
    if (!block) continue;

    // Harvest a small connected cluster before searching again. This makes
    // tree gathering feel continuous instead of: find -> path -> one log ->
    // wait -> repeat.
    for (let i = 0; i < 18 && countItem(bot, x => LOG_MATCH(x.name)) < target; i++) {
      if (!block || !LOG_MATCH(block.name)) break;
      const before = countItem(bot, x => LOG_MATCH(x.name));
      const ok = await digTrackingType(bot, block);
      if (!ok) break;
      await sleep(60);
      const after = countItem(bot, x => LOG_MATCH(x.name));
      if (after <= before) break;

      const nearby = bot.findBlocks({
        matching: b => b && LOG_MATCH(b.name),
        maxDistance: 6,
        count: 12
      });
      const nextPos = nearby
        .map(p => ({ p, d: bot.entity.position.distanceTo(p) }))
        .filter(x => x.d <= 5.5)
        .sort((a, b) => a.d - b.d)[0]?.p;
      block = nextPos ? bot.blockAt(nextPos) : null;
    }
  }
  return countItem(bot, i => LOG_MATCH(i.name));
}

async function mineStone(bot, mcData, target = 32) {
  let attempts = 0;
  while (countItem(bot, i => i.name === 'cobblestone' || i.name === 'cobbled_deepslate') < target && attempts++ < 100) {
    const pos = bot.findBlock({ matching: b => b && STONE_LIKE.includes(b.name), maxDistance: 40 });
    if (pos) {
      const block = bot.blockAt(pos);
      await digTrackingType(bot, block);
      await sleep(100);
      continue;
    }
    // No visible stone: move first, instead of sleeping against an air block forever.
    const targetPos = bot.entity.position.offset(randInt(-5,5), 0, randInt(-5,5));
    await gotoPos(bot, targetPos, 1, 7000);
    await sleep(150);
  }
  return countItem(bot, i => i.name === 'cobblestone' || i.name === 'cobbled_deepslate');
}

const ORE_GROUPS = {
  coal:['coal_ore','deepslate_coal_ore'], iron:['iron_ore','deepslate_iron_ore'], gold:['gold_ore','deepslate_gold_ore'],
  diamond:['diamond_ore','deepslate_diamond_ore'], lapis:['lapis_ore','deepslate_lapis_ore'], redstone:['redstone_ore','deepslate_redstone_ore'], emerald:['emerald_ore','deepslate_emerald_ore']
};

function isSafeToStepInto(bot,pos) {
  const b=bot.blockAt(pos), below=bot.blockAt(pos.offset(0,-1,0));
  if(!b||!below) return false;
  if(/lava/.test(b.name)||/lava/.test(below.name)) return false;
  return true;
}

async function stripMineForOres(bot, mcData, oreNames, targetCount, targetY, maxSteps=250) {
  let found=0, steps=0;
  const dirs=[new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)];
  const dirVec=dirs[Math.floor(Math.random()*dirs.length)];

  // First use pathfinder to reach a safe nearby lower level when possible.
  while(bot.entity.position.y > targetY + 1 && steps++ < Math.min(maxSteps,80)) {
    const here=bot.entity.position;
    const belowFeet=bot.blockAt(here.offset(0,-1,0));
    const belowTwo=bot.blockAt(here.offset(0,-2,0));
    if(!belowFeet || /lava/.test(belowFeet.name) || (belowTwo && /lava/.test(belowTwo.name))) break;
    if(belowFeet.name !== 'air' && belowFeet.name !== 'cave_air') {
      await safeDig(bot, belowFeet);
    }
    if(belowTwo && belowTwo.name !== 'air' && belowTwo.name !== 'cave_air') await safeDig(bot, belowTwo);
    const moved = await gotoPos(bot, here.offset(0,-1,0), 0, 5000);
    if(!moved) break;
    await sleep(100);
  }

  while(found < targetCount && steps++ < maxSteps) {
    const nearOre=bot.findBlock({matching:b=>b && oreNames.includes(b.name), maxDistance:18});
    if(nearOre) {
      const block=bot.blockAt(nearOre);
      if(await digTrackingType(bot,block)) found++;
      await sleep(120);
      continue;
    }

    const front=bot.entity.position.plus(dirVec);
    const head=bot.blockAt(front.offset(0,1,0));
    const feet=bot.blockAt(front);
    if(head && !['air','cave_air'].includes(head.name)) await safeDig(bot,head);
    if(feet && !['air','cave_air'].includes(feet.name)) await safeDig(bot,feet);
    if(!isSafeToStepInto(bot,front)) {
      // Turn to another corridor instead of permanently stopping.
      const alt=dirs.find(d=>isSafeToStepInto(bot,bot.entity.position.plus(d)));
      if(!alt) break;
      dirVec.x=alt.x; dirVec.y=alt.y; dirVec.z=alt.z;
      continue;
    }
    if(!(await gotoPos(bot,front,0,5000))) {
      const alt=dirs.find(d=>isSafeToStepInto(bot,bot.entity.position.plus(d)));
      if(!alt) break;
      dirVec.x=alt.x; dirVec.y=alt.y; dirVec.z=alt.z;
    }
    await sleep(100);
  }
  return found;
}

async function huntNearbyAnimal(bot) {
  const ANIMALS=new Set(['cow','pig','sheep','chicken','rabbit']);
  let entity=Object.values(bot.entities).filter(e=>e.name&&ANIMALS.has(e.name)&&e.position).sort((a,b)=>bot.entity.position.distanceTo(a.position)-bot.entity.position.distanceTo(b.position))[0];
  if(!entity) return false;
  try {
    if(!(await gotoPos(bot,entity.position,2,12000))) return false;
    if(bot.entity.position.distanceTo(entity.position)<4) { bot.attack(entity); await sleep(700); return true; }
  } catch(e) { log('Hunt',`Hata: ${e.message}`); }
  return false;
}

module.exports={LOG_MATCH,STONE_LIKE,ORE_GROUPS,gatherWood,mineStone,stripMineForOres,huntNearbyAnimal,digTrackingType};
