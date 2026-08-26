"use client";

import { useCallback, useMemo, useState } from "react";
import { inferIR, measure, renderIR, type InferError, type Measurement } from "./infer";

/* Deterministic example corpora — small cousins of the benchmark's, generated in-page. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function eventsExample(): unknown {
  const rng = mulberry32(0x5eed);
  const actors = ["ada", "grace", "linus", "edsger", "barbara", "alan"].map((n, i) => ({
    id: `u_${(i + 11).toString(36)}`,
    email: `${n}@acme.io`,
  }));
  const types = ["user.login", "file.upload", "billing.charge", "user.logout"];
  let seq = 4000;
  return Array.from({ length: 24 }, () => ({
    route: "events",
    events: Array.from({ length: 12 + Math.floor(rng() * 10) }, () => {
      const actor = actors[Math.floor(rng() * actors.length)]!;
      seq += 1 + Math.floor(rng() * 3);
      return {
        id: `evt_${seq.toString(36).padStart(6, "0")}_${Math.floor(rng() * 0xffffffff)
          .toString(16)
          .padStart(8, "0")}`,
        type: types[Math.floor(rng() * types.length)]!,
        actorId: actor.id,
        actorEmail: actor.email,
        ok: rng() > 0.08,
        at: 1755000000000 + Math.floor(rng() * 86400000),
        durationMs: Math.floor(rng() * (rng() < 0.9 ? 900 : 45000)),
      };
    }),
  }));
}

function candlesExample(): unknown {
  const rng = mulberry32(0xca4d1e);
  let price = 6412.5;
  return Array.from({ length: 20 }, (_, m) => ({
    symbol: "BTC-EUR",
    interval: "5m",
    candles: Array.from({ length: 30 }, (_, i) => {
      const o = price;
      price = Math.round((price + (rng() - 0.5) * 40) * 100) / 100;
      const h = Math.round(Math.max(o, price) * 100) / 100 + 0.5;
      const l = Math.round(Math.min(o, price) * 100) / 100 - 0.5;
      return { t: 1755000000000 + (m * 30 + i) * 300000, o, h, l, c: price, v: Math.round(rng() * 90000) / 100 };
    }),
  }));
}

function orderExample(): unknown {
  return {
    id: "ord_18f2a4",
    status: "shipped",
    currency: "EUR",
    total: 1848,
    customer: { id: "cus_a91", tier: "plus", country: "DE" },
    lines: [
      { sku: "HX-220", qty: 2, unitPrice: 549 },
      { sku: "HX-CABLE", qty: 3, unitPrice: 250 },
    ],
  };
}

const EXAMPLES: { name: string; hint: string; make: () => unknown }[] = [
  { name: "audit events", hint: "24 responses — recurring actors, machine-made ids", make: eventsExample },
  { name: "candles", hint: "20 responses — strided timestamps, decimal prices", make: candlesExample },
  { name: "single order", hint: "one response, no traffic to learn from", make: orderExample },
];

const NUMBER = new Intl.NumberFormat("en-US");

interface Row {
  label: string;
  bytes: number;
  kind: "baseline" | "generic" | "hyperfly" | "full";
}

function looksLikeCorpus(parsed: unknown): boolean {
  return (
    Array.isArray(parsed) &&
    parsed.length >= 2 &&
    parsed.every((m) => typeof m === "object" && m !== null && !Array.isArray(m))
  );
}

export function Playground() {
  const [text, setText] = useState("");
  const [forceSingle, setForceSingle] = useState(false);
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "error"; error: InferError }
    | { phase: "done"; result: Measurement; schema: string; corpus: boolean }
  >({ phase: "idle" });

  const run = useCallback(
    (input: string, single: boolean) => {
      if (input.trim() === "") {
        setState({ phase: "idle" });
        return;
      }
      if (input.length > 4_000_000) {
        setState({ phase: "error", error: { path: "$", message: "keep it under 4 MB — this all runs in your tab" } });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(input);
      } catch (err) {
        setState({ phase: "error", error: { path: "$", message: `not JSON: ${(err as Error).message}` } });
        return;
      }
      const corpus = !single && looksLikeCorpus(parsed);
      const messages = corpus ? (parsed as unknown[]) : [parsed];
      const inferred = inferIR(messages);
      if ("error" in inferred) {
        setState({ phase: "error", error: inferred.error });
        return;
      }
      const result = measure(inferred.ir, messages);
      if ("error" in result) {
        setState({ phase: "error", error: result.error });
        return;
      }
      setState({ phase: "done", result, schema: renderIR(inferred.ir), corpus });
    },
    [],
  );

  const loadExample = (make: () => unknown) => {
    const value = make();
    const pretty = JSON.stringify(value, null, 2);
    setText(pretty);
    setForceSingle(false);
    run(pretty, false);
  };

  const rows: Row[] = useMemo(() => {
    if (state.phase !== "done") return [];
    const r = state.result;
    const per = (n: number) => Math.round(n / r.messages);
    const out: Row[] = [
      { label: "JSON", bytes: per(r.json), kind: "baseline" },
      { label: "JSON + gzip", bytes: per(r.gzip), kind: "generic" },
      { label: "Hyperfly", bytes: per(r.hyperfly), kind: "hyperfly" },
    ];
    if (r.profiled !== undefined) {
      out.push({ label: "Hyperfly Profiled", bytes: per(r.profiled), kind: "full" });
    }
    return out;
  }, [state]);

  const max = rows.length > 0 ? rows[0]!.bytes : 1;

  return (
    <div className="playground">
      <div className="play-controls">
        <div className="play-examples">
          {EXAMPLES.map((e) => (
            <button key={e.name} type="button" className="bench-tab" title={e.hint} onClick={() => loadExample(e.make)}>
              {e.name}
            </button>
          ))}
        </div>
        <textarea
          className="play-input"
          value={text}
          spellCheck={false}
          placeholder='Paste a JSON response — or an array of responses from the same route, which is what a profile trains on. Try [{"id":"evt_0001_9fa3","user":"kim@acme.io"},{"id":"evt_0002_b21c","user":"kim@acme.io"}] and go from there.'
          onChange={(e) => {
            setText(e.target.value);
            run(e.target.value, forceSingle);
          }}
        />
        <div className="play-meta">
          <label className="play-toggle">
            <input
              type="checkbox"
              checked={forceSingle}
              onChange={(e) => {
                setForceSingle(e.target.checked);
                run(text, e.target.checked);
              }}
            />
            treat a top-level array as one response
          </label>
          <span className="play-privacy">nothing is uploaded — inference, training and encoding run in this tab</span>
        </div>
      </div>

      {state.phase === "error" && (
        <div className="play-error">
          <span className="play-error-path">{state.error.path}</span> {state.error.message}
        </div>
      )}

      {state.phase === "done" && (
        <div className="bench play-results">
          <div className="bench-head">
            <span className="bench-flag">
              {state.corpus
                ? `per message · ${state.result.messages} messages · trained on this traffic`
                : "one response · nothing to train on yet"}
            </span>
          </div>
          <div className="bars">
            {rows.map((row) => (
              <div className="bar" data-kind={row.kind} key={row.label}>
                <span className="bar-label">{row.label}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ transform: `scaleX(${Math.min(1, row.bytes / max)})` }} />
                </span>
                <span className="bar-bytes">{NUMBER.format(row.bytes)} B</span>
                <span className="bar-ratio">
                  {row.kind === "baseline" ? "—" : `${(max / row.bytes).toFixed(1)}×`}
                </span>
              </div>
            ))}
          </div>

          {!state.corpus && (
            <p className="bench-note">
              Paste an <em>array</em> of responses from the same route to unlock the profiled row — recurring values,
              id shapes, and column dependencies only exist across traffic, never inside one response.
            </p>
          )}

          {state.corpus && state.result.profiled !== undefined && (
            <div className="play-learned">
              <p className="play-learned-head">
                what the profile learned
                {state.result.profileBytes !== undefined && (
                  <span>
                    {" "}
                    · {NUMBER.format(state.result.profileBytes)} B out-of-band
                    {state.result.breakEven !== undefined &&
                      ` · pays for itself after ${state.result.breakEven} requests`}
                  </span>
                )}
              </p>
              {state.result.learned.length === 0 ? (
                <p className="play-learned-item">nothing — this traffic has no cross-request structure to learn</p>
              ) : (
                <ul>
                  {state.result.learned.map((l, i) => (
                    <li key={i} className="play-learned-item">
                      <code>{l.path}</code> — {l.what}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <details className="play-schema">
            <summary>inferred schema · fingerprint {state.result.fingerprint.slice(0, 8)}</summary>
            <pre>{state.schema}</pre>
            <p className="footnote">
              Inferred from the payload alone — a real integration declares this in Zod or Pydantic, usually tighter.
              JSON is measured minified; gzip at level 6, the common edge default.
            </p>
          </details>

          {!state.result.roundTripOk && (
            <p className="play-error">round-trip mismatch — these numbers are not trustworthy; please report this payload shape</p>
          )}
        </div>
      )}
    </div>
  );
}
