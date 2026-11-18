// Lapisan data sederhana: cache in-memory + localStorage, stale-while-revalidate,
// dan de-duplikasi request (aman untuk StrictMode: hanya satu fetch berjalan).
const API =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) ||
  "http://localhost:3000";

// durasi segar (ms) per jenis data
const TTL_SESI_SAME = 1000 * 60 * 60 * 24; // daftar surat & qari: segar selama sesi
const TTL_JAM = 1000 * 60 * 60; // 1 jam (ayat + audio)
const LS_TTL = 1000 * 60 * 60 * 24; // localStorage 24 jam

// map request berjalan untuk de-duplikasi
const inFlight = new Map();

// cache in-memory: key -> { data, ts, error }
const memCache = new Map();

function lsKey(kunci) {
  return `quran_${kunci}`;
}

function simpanLS(kunci, data) {
  try {
    localStorage.setItem(lsKey(kunci), JSON.stringify({ v: 1, ts: Date.now(), data }));
  } catch {
    /* storage penuh / private mode — abaikan */
  }
}

function bacaLS(kunci, ttl = LS_TTL) {
  try {
    const mentah = localStorage.getItem(lsKey(kunci));
    if (!mentah) return null;
    const paket = JSON.parse(mentah);
    if (!paket || Date.now() - paket.ts > ttl) return null;
    return paket.data;
  } catch {
    return null;
  }
}

// fetch JSON dengan pengecekan status
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const pesan = `HTTP ${r.status}`;
    console.error(`[dataCache] ${url} -> ${pesan}`);
    throw new Error(pesan);
  }
  return r.json();
}

// ambil data dengan strategi:
// 1) pakai cache in-memory / localStorage jika masih ada (stale-while-revalidate)
// 2) jalankan fetch sekali (de-duplikasi); saat selesai update cache
// 3) jika revalidate gagal dan data lama ada, pertahankan data lama
function ambil(kunci, url, { ttl = TTL_SESI_SAME, persist = false, map = null } = {}) {
  // 1) data lama (in-memory dulu, lalu localStorage)
  let lama = memCache.get(kunci)?.data;
  if (lama === undefined) lama = persist ? bacaLS(kunci) : null;
  if (lama !== undefined && lama !== null) {
    // tampilkan langsung
    const hasil = Promise.resolve({ data: lama, stale: true });
    // perbarui di latar belakang jika sudah tak segar
    const segar =
      memCache.has(kunci) && Date.now() - (memCache.get(kunci).ts ?? 0) < ttl;
    if (!segar) {
      revalidate(kunci, url, ttl, persist, map);
    }
    return hasil;
  }
  // tidak ada data lama: jalankan fetch
  return fetchBaru(kunci, url, ttl, persist, map);
}

async function revalidate(kunci, url, ttl, persist, map) {
  const res = await fetchBaru(kunci, url, ttl, persist, map);
  return res;
}

function fetchBaru(kunci, url, ttl, persist, map) {
  // de-duplikasi: jika fetch berjalan untuk kunci yang sama, pakai yang sama
  if (inFlight.has(kunci)) {
    inFlight.get(kunci).catch(() => {}); // jaga agar tidak jadi unhandled rejection
    return inFlight.get(kunci);
  }
  const p = (async () => {
    const d = await getJSON(url);
    const data = map ? map(d) : d;
    memCache.set(kunci, { data, ts: Date.now() });
    if (persist) simpanLS(kunci, data);
    return { data, stale: false };
  })().finally(() => inFlight.delete(kunci));
  inFlight.set(kunci, p);
  return p;
}

export const cacheData = {
  // daftar surat (segar selama sesi, persist 24 jam)
  surat() {
    return ambil("surat", `${API}/api/surah`, {
      ttl: TTL_SESI_SAME,
      persist: true,
      map: (d) => d.chapters || [],
    });
  },
  // daftar qari (dimuat sekali, persist 24 jam)
  qari() {
    return ambil("reciters", `${API}/api/reciters`, {
      ttl: TTL_SESI_SAME,
      persist: true,
      map: (d) => d.reciters || [],
    });
  },
  // ayat per surat (persist 24 jam)
  ayat(idSurat) {
    return ambil(`ayat_${idSurat}`, `${API}/api/surah/${idSurat}/ayat`, {
      ttl: TTL_JAM,
      persist: true,
      map: (d) => d.verses || [],
    });
  },
  // data audio per qari+surat (persist 24 jam)
  audio(idQari, idSurat) {
    return ambil(`audio_${idQari}_${idSurat}`, `${API}/api/audio/chapter/${idQari}/${idSurat}`, {
      ttl: TTL_JAM,
      persist: true,
      map: (d) => d.audio_file || null,
    });
  },
};

export default cacheData;
