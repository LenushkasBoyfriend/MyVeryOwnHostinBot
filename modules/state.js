'use strict';
// Sunucu yeniden başlasa/bot çöküp yeniden bağlansa bile üssün konumunu
// hatırlamak için basit bir JSON dosyası.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'survival_state.json');

function loadState() {
  try {
    if (fs.existsSync(FILE)) {
      return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    }
  } catch (e) {
    console.log(`[State] Okuma hatası: ${e.message}`);
  }
  return {
    base: null,           // { x, y, z, entrance: {x,y,z,blockName}, shaftPath: [{x,y,z,blockName}] }
    enchantRoomBuilt: false,
    lapisCollected: 0
  };
}

function saveState(state) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.log(`[State] Yazma hatası: ${e.message}`);
  }
}

module.exports = { loadState, saveState };
