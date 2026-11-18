import { useEffect, useRef } from "react";

// Pilihan jumlah pengulangan. null = terus-menerus
const PILIHAN_ULANG = [1, 3, 5, 10, null];

const labelUlang = (n) => (n === null ? "∞" : `${n}x`);

// Pemilih jumlah pengulangan: 1x, 3x, 5x, 10x, terus-menerus
export function KontrolUlang({ nilai, onUbah, label = "Ulangi:" }) {
  return (
    <label className="ulang-kontrol">
      <span>{label}</span>
      <select
        aria-label="Jumlah pengulangan ayat"
        value={String(nilai)}
        onChange={(e) => onUbah(e.target.value === "null" ? null : Number(e.target.value))}
      >
        {PILIHAN_ULANG.map((n) => (
          <option key={String(n)} value={String(n)}>
            {labelUlang(n)}
          </option>
        ))}
      </select>
    </label>
  );
}

// Tombol putar/jeda untuk satu ayat + counter pengulangan
export function TombolAyat({
  nomor,
  aktif,
  sedangBerhenti,
  penghitung,
  disabled,
  tooltip,
  onTombol,
}) {
  const btnRef = useRef(null);

  // sinkronkan atribut aria-disabled + tooltip dengan state React
  useEffect(() => {
    const btn = btnRef.current;
    if (!btn) return;
    if (disabled) {
      btn.setAttribute("aria-disabled", "true");
      btn.title = tooltip;
    } else {
      btn.removeAttribute("aria-disabled");
      btn.removeAttribute("title");
    }
  }, [disabled, tooltip]);

  const tampilIcon = () => {
    if (aktif && !sedangBerhenti) return "⏸";
    return "▷";
  };

  return (
    <span className="ayat-putar">
      <button
        ref={btnRef}
        type="button"
        className={`ayat-play${aktif ? " ayat-play-aktif" : ""}`}
        aria-label={`Putar ayat ${nomor}`}
        onClick={(e) => {
          if (disabled) return;
          e.currentTarget.blur();
          onTombol();
        }}
      >
        {tampilIcon()}
      </button>
      {penghitung && (
        <span className="ulang-counter-kecil" aria-label={`Pengulangan ${penghitung}`}>
          {penghitung}
        </span>
      )}
    </span>
  );
}
