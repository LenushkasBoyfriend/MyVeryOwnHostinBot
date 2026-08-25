'use strict';

const { Vec3, countItem } = require('./utils');

function choosePalette(bot) {
  const has = name => countItem(bot, name) > 0;
  const main = [
    ['stone_bricks', 7], ['polished_deepslate', 6], ['deepslate_bricks', 5], ['spruce_planks', 4], ['oak_planks', 3], ['cobblestone', 2]
  ].sort((a, b) => (countItem(bot, b[0]) * b[1]) - (countItem(bot, a[0]) * a[1])).map(x => x[0]).find(has) || 'cobblestone';
  const floor = [
    ['spruce_planks', 6], ['oak_planks', 5], ['polished_deepslate', 4], ['stone_bricks', 3], ['cobblestone', 2]
  ].map(x => x[0]).find(has) || main;
  const accent = [
    ['dark_oak_planks', 5], ['spruce_planks', 4], ['oak_planks', 3], ['polished_andesite', 2], ['cobblestone', 1]
  ].map(x => x[0]).find(has) || floor;
  return { main, floor, accent, light: has('lantern') ? 'lantern' : (has('torch') ? 'torch' : null), glass: has('glass') ? 'glass' : null };
}

function chooseRoomLayout(config = {}) {
  const roomSize = config.roomSize || { w: 7, h: 5, l: 7 };
  const gap = 5;
  return [
    { id: 'storage', name: 'Depo', dx: 0, dz: -gap, size: roomSize, priority: 100 },
    { id: 'workshop', name: 'Atölye', dx: gap, dz: 0, size: roomSize, priority: 90 },
    { id: 'farm', name: 'Çiftlik', dx: 0, dz: gap, size: roomSize, priority: 80 },
    { id: 'enchant', name: 'Büyü Odası', dx: -gap, dz: 0, size: roomSize, priority: 70 },
    { id: 'smeltery', name: 'Fırın Odası', dx: -gap, dz: -gap, size: roomSize, priority: 85 },
    { id: 'bedroom', name: 'Yatak Odası', dx: gap, dz: -gap, size: roomSize, priority: 65 }
  ];
}

function roomCenter(base, spec) {
  return new Vec3(base.x + spec.dx, base.y, base.z + spec.dz);
}

module.exports = { choosePalette, chooseRoomLayout, roomCenter };
