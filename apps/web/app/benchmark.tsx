"use client";

import { useEffect, useRef, useState } from "react";
import { useInView } from "./reveal";

type Row = {
  label: string;
  bytes: number;
  kind?: "baseline" | "generic" | "binary" | "hyperfly" | "profile" | "full";
};

type Payload = {
  route: string;
  shape: string;
  rows: Row[];
  note: string;
};

const PAYLOADS: Payload[] = [
  {
    route: "GET /v1/events",
    shape: "500 messages · 20–50 audit records each · recurring actors and user agents",
    rows: [
      { label: "JSON", bytes: 12687, kind: "baseline" },
      { label: "JSON + gzip", bytes: 2503, kind: "generic" },
      { label: "JSON + Brotli — edge q4", bytes: 2512, kind: "generic" },
      { label: "Protobuf", bytes: 7190, kind: "binary" },
      { label: "Hyperfly", bytes: 2109, kind: "hyperfly" },
      { label: "Hyperfly + Brotli", bytes: 2054, kind: "profile" },
      { label: "Hyperfly Profiled", bytes: 823, kind: "full" },
    ],
    note: "An audit log repeats itself across requests, not within one: the same user agents, the same actor emails, the same resource ids, request after request. A compressor only ever sees one response and has to rediscover them every time — which is why Brotli takes 55 bytes off and the profile takes 1 231. It learned 692 values once, and pays for itself after ten requests.",
  },
  {
    route: "GET /v1/devices",
    shape: "500 messages · 20–50 telemetry records each · fixed 400-device fleet",
    rows: [
      { label: "JSON", bytes: 7994, kind: "baseline" },
      { label: "JSON + gzip", bytes: 1473, kind: "generic" },
      { label: "JSON + Brotli — edge q4", bytes: 1422, kind: "generic" },
      { label: "Protobuf", bytes: 2007, kind: "binary" },
      { label: "Hyperfly", bytes: 896, kind: "hyperfly" },
      { label: "Hyperfly + Brotli", bytes: 818, kind: "profile" },
      { label: "Hyperfly Profiled", bytes: 638, kind: "full" },
    ],
    note: "An enum with six members is an index, not a string. Bounded integers ship as offsets from their declared minimum and booleans pack into bitmaps — that is the first row, before anything has been compressed or learned. The profile then learns the fleet: the device ids that recur on every page.",
  },
  {
    route: "GET /v1/orders/:id",
    shape: "500 messages · one order each · fixed catalogue and customer base",
    rows: [
      { label: "JSON", bytes: 782, kind: "baseline" },
      { label: "JSON + gzip", bytes: 423, kind: "generic" },
      { label: "JSON + Brotli — edge q4", bytes: 408, kind: "generic" },
      { label: "Protobuf", bytes: 388, kind: "binary" },
      { label: "Hyperfly", bytes: 271, kind: "hyperfly" },
      { label: "Hyperfly + Brotli", bytes: 273, kind: "profile" },
      { label: "Hyperfly Profiled", bytes: 188, kind: "full" },
    ],
    note: "The single-entity response, and the case a general compressor handles worst: under a kilobyte there is nothing yet to build a window from. Brotli actually costs two bytes here rather than saving any — at this size its framing outweighs what it finds. What does work is knowing the catalogue in advance.",
  },
  {
    route: "GET /v1/feed",
    shape: "500 messages · 10–25 posts each · recurring cast of 120 authors",
    rows: [
      { label: "JSON", bytes: 6863, kind: "baseline" },
      { label: "JSON + gzip", bytes: 2307, kind: "generic" },
      { label: "JSON + Brotli — edge q4", bytes: 2294, kind: "generic" },
      { label: "Protobuf", bytes: 4396, kind: "binary" },
      { label: "Hyperfly", bytes: 1908, kind: "hyperfly" },
      { label: "Hyperfly + Brotli", bytes: 1902, kind: "profile" },
      { label: "Hyperfly Profiled", bytes: 1535, kind: "full" },
    ],
    note: "Prose is the hard case: the bodies are genuinely new every time and nothing can invent redundancy that is not there. What does recur are the authors, so that is what the profile takes. This is the narrowest margin on the page, and it is the honest one to look at first.",
  },
  {
    route: "GET /v1/candles",
    shape: "500 messages · 20–50 OHLCV rows each · monotonic timestamps",
    rows: [
      { label: "JSON", bytes: 3225, kind: "baseline" },
      { label: "JSON + gzip", bytes: 928, kind: "generic" },
      { label: "JSON + Brotli — edge q4", bytes: 842, kind: "generic" },
      { label: "Protobuf", bytes: 2034, kind: "binary" },
      { label: "Hyperfly", bytes: 496, kind: "hyperfly" },
      { label: "Hyperfly + Brotli", bytes: 372, kind: "profile" },
      { label: "Hyperfly Profiled", bytes: 372, kind: "full" },
    ],
    note: "Timestamps become deltas and exact-decimal prices travel as integer mantissas rather than eight raw bytes. The last two rows are identical to the byte, and the row is left in to show it: this route's only string sits outside the array, so there is no column for a dictionary to key on and training buys nothing at all.",
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
        <span className="bench-flag">measured — per message, 500-message corpora</span>
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
