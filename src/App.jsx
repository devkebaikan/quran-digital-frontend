import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import "./App.css";
import { KontrolUlang, TombolAyat } from "./KomponenAudio.jsx";
import { cariAyatAktif, cariKataAktif, kataDariWords, penandaAkhir } from "./useSorotanKata.js";
import cacheData from "./dataCache.js";

// hapus tag HTML jika ada di teks terjemahan
const bersih = (t = "") => t.replace(/<[^>]*>/g, "");

// Konstanta kecil (ms) supaya audio tidak terpotong di ujung akhir ayat
const TOLERANSI_MS = 300;

// jeda auto-scroll saat pengguna menggulir manual (ms)
const JEDA_AUTOSCROLL_MS = 4000;

// Konstanta offset jeda awal (detik) supaya kata pertama tidak terpotong saat melewati pembuka
const OFFSET_AWAL_SEKON = 0.05;

// cetak sekali bentuk data timestamps untuk verifikasi (field + satuan)
let cekTsDicetak = false;
function cetakTsSekali(d) {
  if (cekTsDicetak || !d?.audio_file?.timestamps?.length) return;
  cekTsDicetak = true;
  const contoh = d.audio_file.timestamps[0];
  console.info("[timestamps] contoh:", contoh, "| durasi_file_ms:", d.audio_file.duration);
}

function DaftarSurat({ onPilih, prefetch, q, setQ }) {
  const [surahs, setSurahs] = useState(() => {
    // isi awal dari localStorage agar langsung tampil tanpa fetch
    try {
      const mentah = localStorage.getItem("quran_surat");
      if (mentah) {
        const paket = JSON.parse(mentah);
        if (paket && Date.now() - paket.ts <= 1000 * 60 * 60 * 24) return paket.data;
      }
    } catch {
      /* abaikan */
    }
    return null;
  });
  const [error, setError] = useState("");

  useEffect(() => {
    let batalkan = false;
    cacheData
      .surat()
      .then(({ data }) => {
        if (batalkan) return;
        setSurahs(data);
        setError("");
        // Background prefetch ayat di waktu senggang (idle) agar semua surat terbuka instan
        if (data && data.length > 0) {
          const rIC = window.requestIdleCallback || ((cb) => setTimeout(cb, 1000));
          data.forEach((s) => {
            rIC(() => {
              if (!batalkan) cacheData.ayat(s.id).catch(() => {});
            });
          });
        }
      })
      .catch((e) => {
        if (batalkan) return;
        setError(e.message);
      });
    return () => {
      batalkan = true;
    };
  }, []);

  const list = (surahs || []).filter(
    (s) =>
      s.name_simple.toLowerCase().includes(q.toLowerCase()) ||
      s.translated_name.name.toLowerCase().includes(q.toLowerCase()) ||
      String(s.id) === q.trim()
  );

  // prefetch saat hover/fokus kartu: tunggu 150 ms (cache de-duplikasi otomatis)
  const hoverTimerRef = useRef(0);
  const saatHover = (idSurat) => {
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => prefetch(idSurat), 150);
  };
  const saatTinggalkan = () => {
    clearTimeout(hoverTimerRef.current);
  };

  return (
    <>
      <h1>Al-Qur'an Digital</h1>
      <input
        className="search"
        placeholder="Cari surat (nama atau nomor)..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {error && <p className="err">{error}</p>}
      {surahs === null && <p>Memuat...</p>}
      <div className="grid">
        {list.map((s) => (
          <button
            className="card"
            key={s.id}
            onClick={() => onPilih(s)}
            onMouseEnter={() => saatHover(s.id)}
            onMouseLeave={saatTinggalkan}
            onFocus={() => saatHover(s.id)}
            onTouchStart={() => saatHover(s.id)}
          >
              <span className="num">{s.id}</span>
              <div className="info">
                <strong>{s.name_simple}</strong>
                <small>
                  {s.translated_name.name} · {s.verses_count} ayat ·{" "}
                  {s.revelation_place === "makkah" ? "Makkiyah" : "Madaniyah"}
                </small>
              </div>
              <span className="ar">{s.name_arabic}</span>
            </button>
          ))}
      </div>
    </>
  );
}

// Pemutar audio. Mode surat penuh & per-ayat berbagi satu mesin sorotan (rAF).
// Qari di-naikkan dari App (level aplikasi) sehingga tidak di-fetch ulang tiap halaman surat.
const PemutarAudio = forwardRef(function PemutarAudio(
  {
    surat,
    reciters,
    reciterError,
    loadingReciters,
    muatDaftarQari,
    selectedReciter,
    onPilihReciter,
    onJeda,
    onSelesai,
    onSorot,
    onGantiQari,
    onTimestamps,
    onAkhirSurat,
    onStop,
  },
  apiRef
) {
  const [audioData, setAudioData] = useState(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [audioError, setAudioError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const audioRef = useRef(null);
  const onJedaRef = useRef(onJeda);
  const onSelesaiRef = useRef(onSelesai);
  const onSorotRef = useRef(onSorot);
  const onAkhirSuratRef = useRef(onAkhirSurat);
  const onStopRef = useRef(onStop);

  // sinkronkan callback props ke ref agar dipakai oleh listener lama
  useEffect(() => {
    onJedaRef.current = onJeda;
  }, [onJeda]);
  useEffect(() => {
    onSelesaiRef.current = onSelesai;
  }, [onSelesai]);
  useEffect(() => {
    onSorotRef.current = onSorot;
  }, [onSorot]);
  useEffect(() => {
    onAkhirSuratRef.current = onAkhirSurat;
  }, [onAkhirSurat]);
  useEffect(() => {
    onStopRef.current = onStop;
  }, [onStop]);

  // mode per ayat: { kunci, ulang (null=terus), n, sudah }
  const ayatModeRef = useRef({ kunci: null, ulang: 1, n: 0, sudah: false });
  const tsRef = useRef([]);
  const rafRef = useRef(0);
  const lewatiPembuka = true;
  const [aktifVerseKey, setAktifVerseKey] = useState(null);

  // ambil data audio (JSON kecil) saat qari/surat berubah — mp3 tidak diunduh
  useEffect(() => {
    if (!selectedReciter) return;
    setLoadingAudio(true);
    setAudioError("");
    setAudioData(null);
    setIsPlaying(false);
    let batalkan = false;

    cacheData
      .audio(selectedReciter.id, surat.id)
      .then(({ data }) => {
        if (batalkan) return;
        cetakTsSekali(data ? { audio_file: data } : null);
        setAudioData(data);
      })
      .catch((e) => {
        if (!batalkan) {
          setAudioError(e.message);
          console.error("[audio] gagal memuat data audio:", e.message);
        }
      })
      .finally(() => {
        if (!batalkan) setLoadingAudio(false);
      });

    return () => {
      batalkan = true;
    };
  }, [selectedReciter, surat.id]);

  // set src audio dan sinkronkan event
  useEffect(() => {
    if (!audioData?.audio_url || !audioRef.current) return;
    const audio = audioRef.current;
    audio.src = audioData.audio_url;
    // preload="none": mp3 baru diunduh saat putar, bukan saat src di-set
    audio.load();

    // loop rAF: mesin sorotan bersama untuk mode surat penuh & per ayat
    let lastTimeMs = 0;
    const tick = () => {
      const modeAyat = ayatModeRef.current.kunci !== null;
      const ms = audio.currentTime * 1000;

      // perbarui label waktu (throttle >= 100ms) hanya di mode surat penuh
      if (!modeAyat && Math.abs(ms - lastTimeMs) >= 100) {
        lastTimeMs = ms;
        setCurrentTimeMs(ms);
      }

      // tentukan ayat aktif
      let kunciAktif;
      let tAktif;
      if (modeAyat) {
        kunciAktif = ayatModeRef.current.kunci;
        tAktif = tsRef.current.find((x) => x.verse_key === kunciAktif);
      } else {
        tAktif = cariAyatAktif(tsRef.current, ms);
        kunciAktif = tAktif ? tAktif.verse_key : null;
      }

      // label "Ayat N" (mode surat penuh): state kecil, hanya berubah saat ayat berganti
      if (!modeAyat) {
        const baru = kunciAktif ?? null;
        setAktifVerseKey((prev) => (prev === baru ? prev : baru));
      }

      // kirim sorotan kata ke BacaSurat (kedua mode)
      if (tAktif) {
        onSorotRef.current?.({
          mode: modeAyat ? "ayat" : "surat",
          kunci: kunciAktif,
          ms,
          from: tAktif.timestamp_from,
          to: tAktif.timestamp_to,
          segments: tAktif.segments || [],
        });
      }

      // batas akhir ayat (mode per ayat saja)
      if (modeAyat && !ayatModeRef.current.sudah) {
        const ayat = ayatModeRef.current;
        const t = tsRef.current.find((x) => x.verse_key === ayat.kunci);
        if (t && ms >= t.timestamp_to - TOLERANSI_MS) {
          ayat.sudah = true;
          audio.pause();
          if (ayat.ulang === null || ayat.n < ayat.ulang) {
            // pengulangan belum selesai: kembali ke awal ayat
            ayat.n += 1;
            onJedaRef.current?.(true, ayat.n);
            audio.currentTime = t.timestamp_from / 1000;
            audio.play().catch(() => {});
            ayat.sudah = false;
          } else {
            // pengulangan habis: jeda
            onJedaRef.current?.(true, ayat.n);
            ayatModeRef.current.kunci = null;
            ayatModeRef.current.n = 0;
            onSelesaiRef.current?.();
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      // surat selesai (mode surat penuh): hapus sorotan
      if (ayatModeRef.current.kunci === null) {
        onAkhirSuratRef.current?.();
      }
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);

    return () => {
      cancelAnimationFrame(rafRef.current);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.pause();
      audio.removeAttribute("src");
      // bersihkan mode per ayat saat src berganti (qari/surat berubah)
      ayatModeRef.current = { kunci: null, ulang: 1, n: 0, sudah: false };
      setCurrentTimeMs(0);
    };
  }, [audioData?.audio_url]);

  // sinkronkan timestamps (urut timestamp_from agar bisa binary search) ke ref
  useEffect(() => {
    const ts = [...(audioData?.timestamps || [])].sort(
      (a, b) => a.timestamp_from - b.timestamp_from
    );
    tsRef.current = ts;
    onTimestamps?.(ts);
  }, [audioData?.timestamps, onTimestamps]);

  // bersihkan sorotan saat komponen unmount
  useEffect(
    () => () => {
      document.querySelectorAll(".ayat.ayat-aktif").forEach((el) => el.classList.remove("ayat-aktif"));
      document.querySelectorAll(".arab .kata-aktif").forEach((el) => el.classList.remove("kata-aktif"));
    },
    []
  );

  useImperativeHandle(
    apiRef,
    () => ({
      get timestamps() {
        return tsRef.current;
      },
      get isPlaying() {
        return audioRef.current ? !audioRef.current.paused : false;
      },
      // mulai (atau pindah) ayat: aktifkan mode per ayat, loncat ke waktu mulai
      putarAyat(kunci, ulang) {
        const audio = audioRef.current;
        const t = tsRef.current.find((x) => x.verse_key === kunci);
        if (!audio || !t) return;
        ayatModeRef.current = { kunci, ulang: ulang ?? 1, n: 1, sudah: false };
        setAktifVerseKey(kunci);
        audio.currentTime = t.timestamp_from / 1000;
        audio.play().catch(() => {});
      },
      // lanjut dari posisi terakhir
      lanjutAyat() {
        audioRef.current?.play().catch(() => {});
      },
      // jeda sementara (sorotan tetap)
      pause() {
        audioRef.current?.pause();
      },
      // stop total mode per ayat: kembali ke awal ayat aktif, hapus mode per ayat
      stopAyat() {
        const audio = audioRef.current;
        const ayat = ayatModeRef.current;
        if (!audio) return;
        audio.pause();
        const t = tsRef.current.find((x) => x.verse_key === ayat.kunci);
        audio.currentTime = t ? t.timestamp_from / 1000 : 0;
        ayatModeRef.current = { kunci: null, ulang: 1, n: 0, sudah: false };
        setAktifVerseKey(null);
      },
      // ganti qari/surat: stop total, bersihkan src supaya tidak tumpang tindih
      resetAyat() {
        const audio = audioRef.current;
        if (!audio) return;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        ayatModeRef.current = { kunci: null, ulang: 1, n: 0, sudah: false };
        tsRef.current = [];
        setAktifVerseKey(null);
        setCurrentTimeMs(0);
      },
      // hentikan mode surat penuh jika tombol ayat diklik (satu pemutar aktif)
      stopSuratPenuh() {
        const audio = audioRef.current;
        if (!audio) return;
        audio.pause();
      },
      // mulai mode surat penuh dari awal (reset mode per ayat)
      mulaiSurat() {
        const audio = audioRef.current;
        if (!audio) return;
        ayatModeRef.current = { kunci: null, ulang: 1, n: 0, sudah: false };
        audio.currentTime = 0;
        audio.play().catch(() => {});
      },
      // reset ke awal surat (untuk reset label/sorotan)
      resetSurat() {
        const audio = audioRef.current;
        if (!audio) return;
        audio.pause();
        audio.currentTime = 0;
        ayatModeRef.current = { kunci: null, ulang: 1, n: 0, sudah: false };
        setAktifVerseKey(null);
        setCurrentTimeMs(0);
      },
    }),
    []
  );

  const togglePlay = () => {
    if (!audioRef.current) return;
    const audio = audioRef.current;

    // Hitung offset awal: waktu mulai ayat 1 (jika lewatiPembuka aktif)
    let waktuAwal = 0;
    if (lewatiPembuka) {
      if (tsRef.current && tsRef.current.length > 0) {
        const t1 = tsRef.current.find((x) => x.verse_key === `${surat.id}:1`) || tsRef.current[0];
        if (t1 && typeof t1.timestamp_from === "number" && t1.timestamp_from > 0) {
          waktuAwal = Math.max(0, t1.timestamp_from / 1000 - OFFSET_AWAL_SEKON);
        }
      }
    }

    if (isPlaying) {
      audio.pause();
    } else {
      // jika sebelumnya dalam mode per ayat, bersihkan mode per ayat agar jalan penuh
      if (ayatModeRef.current.kunci !== null) {
        ayatModeRef.current = { kunci: null, ulang: 1, n: 0, sudah: false };
        onSelesaiRef.current?.(); // beritahu BacaSurat untuk reset kontrol per ayat
      }
      // Jika audio di posisi 0 atau selesai, lompat ke awal ayat 1 (jika lewati pembuka)
      const pos = audio.currentTime;
      const sudahSelesai = audio.ended || pos === 0;
      if (sudahSelesai && waktuAwal > 0) {
        audio.currentTime = waktuAwal;
      }
      audio.play().catch(() => {});
    }
  };

  const formatWaktu = (ms) => {
    const totalDetik = Math.floor(ms / 1000);
    const menit = Math.floor(totalDetik / 60);
    const detik = totalDetik % 60;
    return `${menit}:${String(detik).padStart(2, "0")}`;
  };

  // Hitung durasi relatif terhadap awal ayat 1 (jika lewatiPembuka)
  const durasiRelatif = () => {
    if (!lewatiPembuka || !tsRef.current?.length) return audioData?.duration || 0;
    const t1 = tsRef.current.find((x) => x.verse_key === `${surat.id}:1`) || tsRef.current[0];
    const msAwal = t1 && typeof t1.timestamp_from === "number" ? t1.timestamp_from : 0;
    return Math.max(0, (audioData?.duration || 0) - msAwal);
  };

  // Hitung waktu relatif terhadap awal ayat 1
  const waktuRelatif = (ms) => {
    if (!lewatiPembuka || !tsRef.current?.length) return ms;
    const t1 = tsRef.current.find((x) => x.verse_key === `${surat.id}:1`) || tsRef.current[0];
    const msAwal = t1 && typeof t1.timestamp_from === "number" ? t1.timestamp_from : 0;
    return Math.max(0, ms - msAwal);
  };

  return (
    <div className="audio-player">
      <div className="audio-controls">
        <label className="audio-label">
          Qari:
          <select
            value={selectedReciter?.id ?? ""}
            onChange={(e) => {
              const r = reciters.find((x) => x.id === Number(e.target.value));
              onGantiQari?.();
              onPilihReciter(r);
            }}
          >
            <option value="" disabled>
              {loadingReciters
                ? "Memuat daftar qari…"
                : reciterError
                  ? "Pilih qari (gagal memuat)"
                  : "Pilih qari"}
            </option>
            {reciters.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.style?.name ? ` — ${r.style.name}` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="audio-actions">
          <button
            className="audio-play-btn"
            onClick={togglePlay}
            disabled={!selectedReciter || loadingAudio || !audioData}
            title={!selectedReciter ? "Pilih qari dulu" : undefined}
            aria-label={isPlaying ? "Jeda" : "Putar"}
          >
            {loadingAudio ? "Memuat audio..." : isPlaying ? "Jeda" : "Putar"}
          </button>
          {audioData && (
            <button
              className="audio-play-btn audio-play-btn-kecil"
              onClick={() => {
                const a = audioRef.current;
                if (!a) return;
                a.pause();
                a.currentTime = 0;
                ayatModeRef.current = { kunci: null, ulang: 1, n: 0, sudah: false };
                setAktifVerseKey(null);
                setCurrentTimeMs(0);
                onStopRef.current?.();
              }}
              aria-label="Stop"
            >
              ⏹ Stop
            </button>
          )}
        </div>
      </div>

      {reciterError && (
        <div className="audio-err-box">
          <p className="err">
            Gagal memuat daftar qari. Pastikan backend berjalan.{" "}
            <small>(detail: {reciterError})</small>
          </p>
          <button className="audio-play-btn audio-play-btn-kecil" onClick={muatDaftarQari}>
            Coba lagi
          </button>
        </div>
      )}
      {audioError && <p className="err">{audioError}</p>}

      <audio ref={audioRef} preload="none" />
      {audioData && (
        <div className="audio-status">
          <span className="audio-time">
            {formatWaktu(waktuRelatif(currentTimeMs))} / {formatWaktu(durasiRelatif())}
          </span>
          {aktifVerseKey !== null && (
            <span className="audio-active-verse">Ayat {aktifVerseKey.split(":")[1]}</span>
          )}
        </div>
      )}
    </div>
  );
});

function BacaSurat({
  surat,
  onKembali,
  reciters,
  reciterError,
  loadingReciters,
  muatDaftarQari,
  selectedReciter,
  onPilihReciter,
}) {
  const [verses, setVerses] = useState(null); // null = belum pernah ada data (tampilkan skeleton)
  const [error, setError] = useState("");

  // mode debug dari URL ?debug=1
  const debugActive = new URLSearchParams(window.location.search).has("debug");

  // state pengendali per ayat
  const [ulang, setUlang] = useState(1); // 1,3,5,10, null=terus-menerus
  const [aktifAyat, setAktifAyat] = useState(null); // kunci ayat yang sedang diulang
  const [jedaAyat, setJedaAyat] = useState(false); // ayat dijeda
  const [nUlang, setNUlang] = useState(0); // penghitung pengulangan sekarang
  const [adaTimestamps, setAdaTimestamps] = useState(false);
  const [timestamps, setTimestamps] = useState([]); // daftar timestamps qari aktif
  // sorotan: kata aktif + ayat aktif (state kecil, per verse)
  const [sorotKata, setSorotKata] = useState({ kunci: null, pos: -1 });
  const [sorotAyat, setSorotAyat] = useState(null); // kunci ayat aktif (kedua mode)
  // debug: { mode, kunci, ms, wordPos, segStart, segEnd, sumber }
  const [kataPosisi, setKataPosisi] = useState(null);
  const kataMapRef = useRef(new Map());
  const kataPosisiPrevRef = useRef(null);
  const pemutarRef = useRef(null);
  // ref untuk auto-scroll jeda manual
  const autoScrollJedaRef = useRef(0);
  const kataSpanRefs = useRef(new Map()); // kunci -> array <span.kata>
  const ayatElRefs = useRef(new Map()); // kunci -> <article.ayat>
  // render bertahap: jumlah ayat yang dirender
  const [jumlahRender, setJumlahRender] = useState(30);

  const kunciAyat = useCallback((no) => `${surat.id}:${no}`, [surat.id]);

  // sinkronkan cache kata dari state verses (tanpa re-render)
  useEffect(() => {
    if (!verses) return;
    const m = new Map();
    for (const v of verses) m.set(kunciAyat(v.verse_number), v.words || []);
    kataMapRef.current = m;
  }, [verses, kunciAyat]);

  // muat ayat (stale-while-revalidate: jika ada data lama tampilkan dulu)
  useEffect(() => {
    let batalkan = false;
    // tampilkan langsung jika ada di cache (tidak ada layar kosong)
    cacheData.ayat(surat.id).then(({ data, stale }) => {
      if (batalkan) return;
      setVerses(data);
      if (!stale) setError("");
    });
    // perbarui di latar belakang (cacheData sudah melakukan revalidate bila stale)
    window.scrollTo(0, 0);
    return () => {
      batalkan = true;
    };
  }, [surat.id]);

  // tangani error pemuatan ayat
  useEffect(() => {
    let batalkan = false;
    cacheData
      .ayat(surat.id)
      .catch((e) => {
        if (batalkan) return;
        setError(e.message);
      });
    return () => {
      batalkan = true;
    };
  }, [surat.id]);

  // render bertahap: tambah ayat di waktu senggang
  useEffect(() => {
    if (!verses || jumlahRender >= verses.length) return;
    const rIC =
      window.requestIdleCallback ||
      ((cb) => setTimeout(() => cb({ didTimeout: true }), 100));
    const id = rIC(() => {
      setJumlahRender((n) => Math.min(n + 30, verses.length));
    });
    return () => {
      const cIC = window.cancelIdleCallback || clearTimeout;
      cIC(id);
    };
  }, [verses, jumlahRender]);

  // pastikan ayat aktif tersorot selalu dirender
  useEffect(() => {
    if (!sorotAyat || !verses) return;
    const no = Number(sorotAyat.split(":")[1]);
    if (no > jumlahRender) setJumlahRender(Math.min(no, verses.length));
  }, [sorotAyat, verses, jumlahRender]);

  const handleTimestamps = useCallback((ts) => {
    setTimestamps(ts);
    setAdaTimestamps(ts.length > 0);
  }, []);

  // callback dari PemutarAudio: sorotan kata + ayat aktif (kedua mode, dari rAF)
  const handleSorot = useCallback(
    ({ mode, kunci, ms, from, to, segments }) => {
      const kata = kataMapRef.current.get(kunci)?.filter((w) => w.type === "word");
      if (!kata || kata.length === 0) return;
      const hasil = cariKataAktif(kata, segments, from, to, ms);
      if (!hasil) return;

      // kata aktif (state kecil per verse)
      setSorotKata((prev) =>
        prev.kunci === kunci && prev.pos === hasil.wordPos
          ? prev
          : { kunci, pos: hasil.wordPos }
      );
      // ayat aktif
      setSorotAyat(kunci);

      // debug: update hanya jika kata/position berubah
      if (debugActive) {
        const prevP = kataPosisiPrevRef.current;
        if (!prevP || prevP.kunci !== kunci || prevP.wordPos !== hasil.wordPos) {
          kataPosisiPrevRef.current = {
            mode,
            kunci,
            ms,
            wordPos: hasil.wordPos,
            segStart: hasil.segStart,
            segEnd: hasil.segEnd,
            sumber: hasil.sumber,
          };
          setKataPosisi(kataPosisiPrevRef.current);
        }
      }
    },
    [debugActive]
  );

  // hapus semua sorotan (stop / selesai / ganti qari)
  const hapusSorotan = useCallback(() => {
    setSorotKata({ kunci: null, pos: -1 });
    setSorotAyat(null);
    setKataPosisi(null);
    kataPosisiPrevRef.current = null;
    // bersihkan class lewat ref (hindari querySelectorAll)
    for (const spans of kataSpanRefs.current.values()) {
      spans.forEach((s) => s.classList.remove("kata-aktif"));
    }
    for (const el of ayatElRefs.current.values()) {
      el.classList.remove("ayat-aktif");
    }
  }, []);

  // klik tombol ayat di baris ayat (mode per ayat; menghentikan surat penuh)
  const klikTombolAyat = (no) => {
    const p = pemutarRef.current;
    if (!p) return;
    if (!p.timestamps.some((t) => t.verse_key === kunciAyat(no))) return;
    const k = kunciAyat(no);

    if (aktifAyat === k && jedaAyat) {
      // lanjut dari posisi terakhir
      p.lanjutAyat();
      setJedaAyat(false);
      setNUlang(1);
      return;
    }
    if (aktifAyat === k && p.isPlaying) {
      // jeda sementara (sorotan tetap di kata terakhir)
      p.pause();
      setJedaAyat(true);
      return;
    }
    // mulai (atau pindah) ayat: hentikan surat penuh, reset counter
    p.stopSuratPenuh();
    setNUlang(1);
    setAktifAyat(k);
    setJedaAyat(false);
    p.putarAyat(k, ulang);
  };

  // tombol stop per ayat
  const stopAyat = () => {
    const p = pemutarRef.current;
    if (!p) return;
    p.stopAyat();
    setAktifAyat(null);
    setJedaAyat(false);
    setNUlang(0);
    hapusSorotan();
  };

  // callback dari pemutar: audio dijeda/berhenti oleh mode per ayat
  const handleJeda = (olehPerAyat, n) => {
    if (olehPerAyat && n !== undefined) setNUlang(n);
  };

  // callback dari pemutar: pengulangan habis, audio stop otomatis
  const handleSelesai = () => {
    setAktifAyat(null);
    setJedaAyat(false);
    setNUlang(0);
    hapusSorotan();
  };

  // callback dari pemutar: surat penuh selesai (ended) -> hapus sorotan, label kembali Putar
  const handleAkhirSurat = useCallback(() => {
    hapusSorotan();
  }, [hapusSorotan]);

  // ganti qari saat per-ayat aktif: stop, muat qari baru, reset semua
  const handleResetPerAyat = () => {
    const p = pemutarRef.current;
    if (p) {
      p.stopAyat();
      p.resetAyat();
    }
    setAktifAyat(null);
    setJedaAyat(false);
    setNUlang(0);
    hapusSorotan();
  };

  const displayCounter =
    aktifAyat && nUlang > 0 ? (ulang === null ? `${nUlang}/∞` : `${nUlang}/${ulang}`) : null;

  // terapkan sorotan kata via ref (hanya ubah class, tanpa re-render seluruh daftar)
  useEffect(() => {
    for (const [k, spans] of kataSpanRefs.current) {
      spans.forEach((s, i) => {
        const should = k === sorotKata.kunci && i === sorotKata.pos;
        s.classList.toggle("kata-aktif", should);
      });
    }
  }, [sorotKata]);

  // terapkan sorotan kartu ayat aktif + auto-scroll saat ayat berganti
  useEffect(() => {
    for (const [k, el] of ayatElRefs.current) {
      el.classList.toggle("ayat-aktif", k === sorotAyat);
    }
    // auto-scroll hanya saat ayat aktif benar-benar berganti
    if (sorotAyat) {
      const el = ayatElRefs.current.get(sorotAyat);
      const sekarang = Date.now();
      if (el && sekarang - autoScrollJedaRef.current > 0) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [sorotAyat]);

  // deteksi scroll manual saat audio berjalan -> jeda auto-scroll 4 detik
  useEffect(() => {
    const onScroll = () => {
      if (sorotAyat) autoScrollJedaRef.current = Date.now() + JEDA_AUTOSCROLL_MS;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [sorotAyat]);

  // bersihkan sorotan saat unmount
  useEffect(
    () => () => {
      hapusSorotan();
    },
    [hapusSorotan]
  );

  return (
    <>
      <button className="back" onClick={onKembali}>← Daftar surat</button>
      <header className="head">
        <h1>{surat.name_arabic}</h1>
        <p>
          {surat.name_simple} · {surat.translated_name.name} ·{" "}
          {surat.verses_count} ayat
        </p>
      </header>
      <PemutarAudio
        ref={pemutarRef}
        surat={surat}
        reciters={reciters}
        reciterError={reciterError}
        loadingReciters={loadingReciters}
        muatDaftarQari={muatDaftarQari}
        selectedReciter={selectedReciter}
        onPilihReciter={onPilihReciter}
        onJeda={handleJeda}
        onSelesai={handleSelesai}
        onSorot={handleSorot}
        onGantiQari={handleResetPerAyat}
        onTimestamps={handleTimestamps}
        onAkhirSurat={handleAkhirSurat}
        onStop={hapusSorotan}
      />
      <div className="kontrol-per-ayat">
        <div className="ulang-baris">
          <span className="ulang-label">Pengulangan ayat:</span>
          <KontrolUlang nilai={ulang} onUbah={setUlang} />
          {displayCounter && <span className="ulang-counter-kecil">{displayCounter}</span>}
        </div>
        {aktifAyat && (
          <div className="ulang-baris ulang-stop">
            <button className="audio-play-btn audio-play-btn-kecil" onClick={stopAyat}>
              ⏹ Stop
            </button>
          </div>
        )}
      </div>
      {surat.bismillah_pre && (
        <p className="bismillah">بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ</p>
      )}
      {error && <p className="err">{error}</p>}
      {verses === null && (
        <div className="skeleton-list">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton-ayat">
              <div className="skeleton-header" />
              <div className="skeleton-arab" />
              <div className="skeleton-arti" />
            </div>
          ))}
        </div>
      )}
      <div className="ayat-list">
        {(verses ? verses.slice(0, jumlahRender) : []).map((v) => {
          const k = kunciAyat(v.verse_number);
          const dis = !adaTimestamps;
          const tip = dis ? "Qari terpilih tidak punya timestamps per ayat" : "";
          const isAktif = aktifAyat === k;
          const tsItem = timestamps.find((t) => t.verse_key === k);
          const kata = kataDariWords(v.words);
          const endWord = penandaAkhir(v.words);
          const hasSeg = tsItem?.segments && tsItem.segments.length > 0;
          const pakaiPerkiraan = hasSeg ? kata.length !== tsItem.segments.length : false;
          const tooltipPerkiraan = pakaiPerkiraan ? "Sorotan kata berupa perkiraan untuk qari ini" : "";

          const registerSpan = (pos, span) => {
            let arr = kataSpanRefs.current.get(k);
            if (!arr) {
              arr = [];
              kataSpanRefs.current.set(k, arr);
            }
            if (span) arr[pos] = span;
          };
          const registerAyat = (el) => {
            if (el) ayatElRefs.current.set(k, el);
          };

          return (
            <article
              ref={registerAyat}
              className="ayat"
              key={v.id}
              data-verse-number={v.verse_number}
              title={tooltipPerkiraan}
            >
              <div className="ayat-header-row">
                <div className="ayat-no">{v.verse_number}</div>
                <TombolAyat
                  nomor={v.verse_number}
                  aktif={isAktif}
                  sedangBerhenti={isAktif && jedaAyat}
                  penghitung={isAktif ? displayCounter : null}
                  disabled={dis}
                  tooltip={tip}
                  onTombol={() => klikTombolAyat(v.verse_number)}
                />
              </div>
              <p className="arab" dir="rtl" lang="ar">
                {kata.length > 0
                  ? kata.map((w) => (
                      <span
                        key={w.position}
                        ref={(s) => registerSpan(w.position, s)}
                        className="kata"
                        data-pos={w.position}
                      >
                        {w.text}{" "}
                      </span>
                    ))
                  : v.text_uthmani}
                <span className="ayat-end" aria-hidden="true">
                  <span className="ayat-end-no">{endWord?.text || v.verse_number}</span>
                </span>
              </p>
              <p className="arti">{bersih(v.translations?.[0]?.text)}</p>
            </article>
          );
        })}
      </div>
      {debugActive && kataPosisi && (
        <div className="debug-overlay">
          <div>
            <span>mode:</span> {kataPosisi.mode === "ayat" ? "ayat" : "surat"}
          </div>
          <div>
            <span>currentTime:</span> {Math.round(kataPosisi.ms)}ms
          </div>
          <div>
            <span>verse:</span> {kataPosisi.kunci}
          </div>
          <div>
            <span>wordPos:</span> {kataPosisi.wordPos}
          </div>
          <div>
            <span>seg:</span> {kataPosisi.segStart}ms - {kataPosisi.segEnd}ms
          </div>
          <div>
            <span>sumber:</span> {kataPosisi.sumber}
          </div>
          <div>
            <span>lewatiPembuka:</span> {lewatiPembuka ? "ya" : "tidak"}
          </div>
          <div>
            <span>awalAyat1:</span>{" "}
            {(() => {
              const t1 =
                (timestamps?.find((t) => t.verse_key === `${surat.id}:1`) ||
                  timestamps?.[0])?.timestamp_from;
              return t1 ? (t1 / 1000).toFixed(2) + "s" : "n/a";
            })()}
          </div>
        </div>
      )}
    </>
  );
}

export default function App() {
  const [surat, setSurat] = useState(null);
  // qari: dimuat sekali di level aplikasi, bukan tiap halaman surat
  const [reciters, setReciters] = useState(() => {
    try {
      const mentah = localStorage.getItem("quran_reciters");
      if (mentah) {
        const paket = JSON.parse(mentah);
        if (paket && Date.now() - paket.ts <= 1000 * 60 * 60 * 24) return paket.data;
      }
    } catch {
      /* abaikan */
    }
    return [];
  });
  const [reciterError, setReciterError] = useState("");
  const [loadingReciters, setLoadingReciters] = useState(false);
  const [selectedReciter, setSelectedReciter] = useState(null);
  const [q, setQ] = useState("");

  const muatDaftarQari = useCallback(() => {
    setLoadingReciters(true);
    setReciterError("");
    cacheData
      .qari()
      .then(({ data }) => {
        setReciters(data);
        setSelectedReciter((prev) => (prev ? prev : data[0] || null));
      })
      .catch((e) => {
        setReciterError(e.message);
        console.error("[qari] gagal memuat daftar qari:", e.message);
      })
      .finally(() => setLoadingReciters(false));
  }, []);

  useEffect(() => {
    muatDaftarQari();
  }, [muatDaftarQari]);

  // pilih qari dari pemutar (mengganti qari)
  const onPilihReciter = useCallback(
    (r) => {
      setSelectedReciter(r);
    },
    []
  );

  // prefetch ayat + audio (JSON) untuk surat yang di-hover
  const prefetch = useCallback(
    (idSurat) => {
      cacheData.ayat(idSurat).catch(() => {});
      if (selectedReciter) {
        cacheData.audio(selectedReciter.id, idSurat).catch(() => {});
      }
    },
    [selectedReciter]
  );

  return (
    <main className="wrap">
      {surat ? (
        <BacaSurat
          surat={surat}
          onKembali={() => setSurat(null)}
          reciters={reciters}
          reciterError={reciterError}
          loadingReciters={loadingReciters}
          muatDaftarQari={muatDaftarQari}
          selectedReciter={selectedReciter}
          onPilihReciter={onPilihReciter}
        />
      ) : (
        <DaftarSurat onPilih={setSurat} prefetch={prefetch} q={q} setQ={setQ} />
      )}
    </main>
  );
}
