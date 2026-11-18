// Mesin sorotan kata bersama untuk mode surat penuh & per ayat.
// Semua waktu dalam milidetik absolut sejak awal file audio surat.

// urut segmen per position (1-based) agar pencarian aman
export function urutSegmen(segments) {
  return [...(segments || [])].sort((a, b) => a[0] - b[0]);
}

// perkiraan waktu kata (ms absolut) dari durasi ayat dibagi proporsional jumlah huruf
export function perkiraKata(kata, fromMs, toMs) {
  const totalHuruf = kata.reduce((a, w) => a + w.text.length, 0);
  const durasi = Math.max(toMs - fromMs, 1);
  let akumulasi = 0;
  const hasil = kata.map((w) => {
    const start = Math.round(fromMs + (akumulasi / totalHuruf) * durasi);
    akumulasi += w.text.length;
    const end = Math.round(fromMs + (akumulasi / totalHuruf) * durasi);
    return { start, end };
  });
  return hasil;
}

// susun kata Arab dari array words backend (type "word"), urut position
export function kataDariWords(words) {
  return (words || [])
    .filter((w) => w.type === "word")
    .sort((a, b) => a.position - b.position);
}

// penanda akhir ayat (type "end")
export function penandaAkhir(words) {
  return (words || []).find((w) => w.type === "end") || null;
}

// Cari ayat aktif dari daftar timestamps (harus urut timestamp_from).
// Waktu di celah antar ayat / sebelum ayat pertama: kembalikan null (tanpa sorotan).
export function cariAyatAktif(timestamps, ms) {
  if (!timestamps?.length) return null;
  // binary search: terakhir yang timestamp_from <= ms
  let lo = 0;
  let hi = timestamps.length - 1;
  let hasil = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = timestamps[mid];
    if (t.timestamp_from <= ms) {
      hasil = t;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (hasil && ms >= hasil.timestamp_to) return null; // di celah setelah ayat ini
  return hasil;
}

// Tentukan kata aktif (position 1-based) dalam sebuah ayat pada waktu ms.
// seg = urutSegmen(segments); jika tak ada/mismatch, pakai perkiraan.
// Return { wordPos, segStart, segEnd, sumber, pakaiPerkiraan }
export function cariKataAktif(kata, segments, fromMs, toMs, ms) {
  if (!kata || kata.length === 0) return null;
  let seg = segments;
  let sumber = "segments";
  let pakaiPerkiraan = false;
  if (!seg || seg.length === 0 || seg.length !== kata.length) {
    seg = perkiraKata(kata, fromMs, toMs).map((p, i) => [kata[i].position, p.start, p.end]);
    sumber = "perkiraan";
    pakaiPerkiraan = true;
  }
  seg = urutSegmen(seg);
  // cari segmen yang mencakup ms; celah antar kata -> kata sebelumnya tetap aktif
  let i = 0;
  for (let j = 0; j < seg.length; j++) {
    if (ms < seg[j][1]) break;
    i = j;
  }
  const s = seg[i];
  return {
    wordPos: s[0],
    segStart: s[1],
    segEnd: s[2],
    sumber,
    pakaiPerkiraan,
  };
}
