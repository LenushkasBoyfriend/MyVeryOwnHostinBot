'use strict';
/*
 * Self-Awareness.
 *
 * Bu modül botun "bilinci" değil - felsefi bir iddiası yok. Yaptığı şey daha
 * somut: botun sahip olduğu tüm modülleri/yetenekleri tek bir listede tutar,
 * böylece hem loglarda hem konsol komutlarında hem de karar verirken "elimde
 * şunlar var, şunları yapabilirim" diye kendi yeteneklerine referans
 * verebilir. Yeni bir modül eklendiğinde bu listeye eklenmesi yeterli.
 */

const { loadState } = require('./state');

const CAPABILITIES = [
  { id: 'decisionEngine', label: 'Karar motoru', desc: 'Anlık duruma göre hedefleri puanlayıp en uygununu seçer.' },
  { id: 'experienceEngine', label: 'Deneyim öğrenimi', desc: 'Deneme -> sonuç -> ödül döngüsüyle hangi eylemin ne zaman işe yaradığını öğrenir.' },
  { id: 'habitEngine', label: 'Alışkanlık/hata hafızası', desc: 'Tekrar eden başarıları pekiştirir, tekrar eden hataları güçlü şekilde bastırır.' },
  { id: 'adaptivePlanner', label: 'Uyarlanabilir strateji', desc: 'Duruma göre temkinli/dengeli/verimli/keşifçi mod arasında geçiş yapar.' },
  { id: 'goalManager', label: 'Uzun vadeli hedefler', desc: 'Hayatta kalma, ev, ekipman, yemek/yakıt, çiftlik, keşif gibi kalıcı hedefleri takip eder.' },
  { id: 'gathering', label: 'Kaynak toplama', desc: 'Odun kesme, taş/cevher madenciliği, hayvan avlama.' },
  { id: 'farming', label: 'Çiftçilik', desc: 'Tohum toplama, toprağı sürme, ekme, hasat edip yeniden ekme.' },
  { id: 'baseBuilder', label: 'Üs inşası', desc: 'Gizli, girişi kamufle edilmiş, birden fazla odadan oluşan bir üs kurar; zemin için estetik bir blok seçer.' },
  { id: 'chestSystem', label: 'Sandık düzenleme', desc: 'Eşyaları kategoriye göre (blok/yemek/ekipman/değerli/genel) ayrı sandıklara dağıtır.' },
  { id: 'enchanting', label: 'Büyü', desc: 'Kütüphane odası kurar, en iyi büyüyü seçip ekipmanına uygular.' },
  { id: 'craftKnowledge', label: 'Genel üretim bilgisi', desc: 'Sabit bir tarif listesine bağlı değil; oyunun tarif verisini kullanarak herhangi bir eşyayı nasıl üreteceğini kendisi çıkarır.' },
  { id: 'knowledgeEngine', label: 'Dış bilgi/YouTube öğrenimi', desc: 'İnternetten ve YouTube video sayfalarından (altyazı varsa) teknik araştırır; bunu kendi pratik sonucuyla doğrular.' },
  { id: 'playerMemory', label: 'Oyuncu hafızası', desc: 'Gördüğü oyunculara güven/tehdit skoru tutar.' },
  { id: 'autonomy', label: 'Otonom davranış', desc: 'Düşünme gecikmesi, kasıtlı kusurlu seçimler ve öğrenilmiş hata kaçınması ile daha insansı karar verir.' }
];

function listCapabilities() {
  return CAPABILITIES;
}

// Botun şu anki durumuna göre kısa, okunabilir bir "kendini anlatma" metni üretir.
// Bilinç iddiası değil - yalnızca hangi sistemlerin aktif ve neyle meşgul olduğunun raporu.
function describeSelf(bot, cfg = {}) {
  const state = loadState();
  const active = [];
  active.push('karar motoru ve deneyim/alışkanlık öğrenimi her zaman çalışıyor');
  if (cfg.base && cfg.base.enabled !== false) active.push(state.base ? `bir üssü var (${Object.keys(state.base.rooms || {}).join(', ') || 'tek oda'})` : 'henüz kalıcı bir üssü yok, arıyor');
  if (cfg.farming && cfg.farming.enabled !== false) active.push(state.hasFarm ? 'kendi çiftliği var' : 'henüz çiftlik kurmadı');
  if (state.base && state.base.chestMap) active.push(`${Object.keys(state.base.chestMap).length} kategori sandığı düzenledi`);
  if (cfg.enchanting && cfg.enchanting.enabled !== false) active.push(state.enchantRoomBuilt ? 'büyü odası hazır' : 'büyü odası henüz kurulmadı');

  return {
    capabilities: CAPABILITIES.map(c => c.id),
    status: active
  };
}

function report() {
  return CAPABILITIES.map(c => `- ${c.label}: ${c.desc}`).join('\n');
}

module.exports = { CAPABILITIES, listCapabilities, describeSelf, report };
