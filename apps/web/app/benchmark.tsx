"use client";

import { useEffect, useRef, useState } from "react";
import { useInView } from "./reveal";

type Row = {
  label: string;
  bytes: number;
  kind?: "baseline" | "generic" | "binary" | "hyperfly" | "profile";
};

type Payload = {
  route: string;
  shape: string;
  rows: Row[];
  note: string;
};

const PAYLOADS: Payload[] = [
  {
    route: "GET /v1/candles",
    shape: "1 000 OHLCV rows · 7 numeric columns · monotonic timestamps",
    rows: [
      { label: "JSON", bytes: 88209, kind: "baseline" },
      { label: "JSON + gzip", bytes: 21705, kind: "generic" },
      { label: "JSON + Brotli (max)", bytes: 14716, kind: "generic" },
      { label: "Protobuf", bytes: 56996, kind: "binary" },
      { label: "Hyperfly · columnar", bytes: 12628, kind: "hyperfly" },
      { label: "Hyperfly + Brotli", bytes: 7917, kind: "profile" },
    ],
    note: "Columns ride separately: timestamps become deltas, and prices that are exact decimals travel as integer mantissas instead of eight raw bytes. No entropy coder is involved yet — this is layout alone beating Brotli's best effort.",
  },
  {
    route: "GET /v1/devices",
    shape: "500 telemetry records · enums · bounded integers · repeated ids",
    rows: [
      { label: "JSON", bytes: 113443, kind: "baseline" },
      { label: "JSON + gzip", bytes: 17026, kind: "generic" },
      { label: "JSON + Brotli (max)", bytes: 12609, kind: "generic" },
      { label: "Protobuf", bytes: 29056, kind: "binary" },
      { label: "Hyperfly · columnar", bytes: 17981, kind: "hyperfly" },
      { label: "Hyperfly + Brotli", bytes: 9446, kind: "profile" },
    ],
    note: "An enum with six members is an index, not a string. Bounded integers ship as offsets from their declared minimum, booleans pack into bitmaps, and transport compression stacks on top of all of it.",
  },
  {
    route: "GET /v1/feed",
    shape: "50 posts · nested authors · free-form text bodies",
    rows: [
      { label: "JSON", bytes: 22245, kind: "baseline" },
      { label: "JSON + gzip", bytes: 7775, kind: "generic" },
      { label: "JSON + Brotli (max)", bytes: 6576, kind: "generic" },
      { label: "Protobuf", bytes: 15232, kind: "binary" },
      { label: "Hyperfly", bytes: 14560, kind: "hyperfly" },
      { label: "Hyperfly + Brotli", bytes: 7225, kind: "profile" },
    ],
    note: "Structure compresses; prose does not. When the payload is mostly human text, Brotli keeps the crown — Hyperfly removes the envelope and steps aside. Route-trained dictionaries are what change this picture, and they do not exist yet.",
  },
];

const NUMBER = new Intl.NumberFormat("en-US");

function useCountUp(target: number, active: boolean) {
  const [value, setValue] = useState(active ? target : 0);
  const previous = useRef(0);

  useEffect(() => {
    if (!active) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      previous.current = target;
      setValue(target);
      return;
    }

    const from = previous.current;
    const start = performance.now();
    const duration = 900;
    let raf = 0;

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(from + (target - from) * eased);
      setValue(next);
      if (t < 1) raf = requestAnimationFrame(step);
      else previous.current = target;
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, active]);

  return value;
}

function Bar({ row, max, active, index }: { row: Row; max: number; active: boolean; index: number }) {
  const bytes = useCountUp(row.bytes, active);
  const scale = active ? row.bytes / max : 0;
  const ratio = max / row.bytes;

  return (
    <div className="bar" data-kind={row.kind}>
      <span className="bar-label">{row.label}</span>
      <span className="bar-track">
        <span
          className="bar-fill"
          style={{ transform: `scaleX(${scale})`, transitionDelay: `${index * 70}ms` }}
        />
      </span>
      <span className="bar-bytes">{NUMBER.format(bytes)} B</span>
      <span className="bar-ratio">{row.kind === "baseline" ? "—" : `${ratio.toFixed(1)}×`}</span>
    </div>
  );
}

export function Benchmark() {
  const [index, setIndex] = useState(0);
  const { ref, inView } = useInView<HTMLDivElement>(0.2);
  const payload = PAYLOADS[index]!;
  const max = payload.rows[0]!.bytes;

  return (
    <div className="bench" ref={ref}>
      <div className="bench-head">
        <div className="bench-tabs" role="tablist" aria-label="Example payload">
          {PAYLOADS.map((item, i) => (
            <button
              key={item.route}
              type="button"
              role="tab"
              aria-selected={i === index}
              className="bench-tab"
              data-active={i === index ? "" : undefined}
              onClick={() => setIndex(i)}
            >
              {item.route}
            </button>
          ))}
        </div>
        <span className="bench-flag">measured — synthetic corpora, reference implementation</span>
      </div>

      <p className="bench-shape">{payload.shape}</p>

      <div className="bars">
        {payload.rows.map((row, i) => (
          <Bar key={row.label} row={row} max={max} active={inView} index={i} />
        ))}
      </div>

      <p className="bench-note">{payload.note}</p>
    </div>
  );
}
