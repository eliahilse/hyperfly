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
      { label: "JSON", bytes: 180400, kind: "baseline" },
      { label: "JSON + gzip", bytes: 38900, kind: "generic" },
      { label: "JSON + Brotli", bytes: 31240, kind: "generic" },
      { label: "MessagePack", bytes: 92100, kind: "binary" },
      { label: "Hyperfly · schema", bytes: 24020, kind: "hyperfly" },
      { label: "Hyperfly · profiled", bytes: 9860, kind: "profile" },
    ],
    note: "Columnar layout separates the series; timestamps and prices become deltas against their own neighbours instead of independent decimal strings.",
  },
  {
    route: "GET /v1/devices",
    shape: "500 telemetry records · enums · bounded integers · repeated device ids",
    rows: [
      { label: "JSON", bytes: 132800, kind: "baseline" },
      { label: "JSON + gzip", bytes: 26400, kind: "generic" },
      { label: "JSON + Brotli", bytes: 21900, kind: "generic" },
      { label: "MessagePack", bytes: 71300, kind: "binary" },
      { label: "Hyperfly · schema", bytes: 15700, kind: "hyperfly" },
      { label: "Hyperfly · profiled", bytes: 6240, kind: "profile" },
    ],
    note: "An enum with six members is six symbols, not six strings. Bounded integers get exactly the bits their range requires, and the id dictionary ships once with the profile.",
  },
  {
    route: "GET /v1/feed",
    shape: "50 posts · nested authors · free-form text bodies",
    rows: [
      { label: "JSON", bytes: 86400, kind: "baseline" },
      { label: "JSON + gzip", bytes: 22700, kind: "generic" },
      { label: "JSON + Brotli", bytes: 19180, kind: "generic" },
      { label: "MessagePack", bytes: 58900, kind: "binary" },
      { label: "Hyperfly · schema", bytes: 31450, kind: "hyperfly" },
      { label: "Hyperfly · profiled", bytes: 14320, kind: "profile" },
    ],
    note: "Structure compresses; prose does not. When the payload is mostly human text the advantage narrows to the envelope, and a general-purpose compressor stays competitive.",
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
        <span className="bench-flag">illustrative — modelled, not measured</span>
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
