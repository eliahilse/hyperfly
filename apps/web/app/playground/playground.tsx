"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/**
 * An integer literal JSON.parse would silently round. String literals are
 * stripped first so digits inside values ("id": "12345678901234567890")
 * never trip the check — only bare number tokens can.
 */
function findUnsafeInteger(text: string): string | null {
  const outsideStrings = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const candidates = outsideStrings.match(/-?\d{16,}(?![\d.eE])/g);
  if (!candidates) return null;
  for (const c of candidates) {
    const abs = c.startsWith("-") ? c.slice(1) : c;
    if (abs.length > 16 || BigInt(abs) > 9007199254740991n) return c;
  }
  return null;
}

type Mode = "auto" | "corpus" | "single";

interface Done {
  phase: "done";
  result: Measurement;
  schema: string;
  assumptions: string[];
  corpus: boolean;
  topLevelArray: boolean;
  arrayLength: number;
}

export function Playground() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [state, setState] = useState<{ phase: "idle" } | { phase: "error"; error: InferError } | Done>({
    phase: "idle",
  });
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback((input: string, chosen: Mode) => {
    if (input.trim() === "") {
      setState({ phase: "idle" });
      return;
    }
    if (input.length > 4_000_000) {
      setState({ phase: "error", error: { path: "$", message: "keep it under 4 MB — this all runs in your tab" } });
      return;
    }
    const unsafe = findUnsafeInteger(input);
    if (unsafe) {
      setState({
        phase: "error",
        error: {
          path: "$",
          message: `${unsafe.slice(0, 24)}… is outside ±(2^53−1); JavaScript's JSON.parse would silently round it, so it is rejected instead`,
        },
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch (err) {
      setState({ phase: "error", error: { path: "$", message: `not JSON: ${(err as Error).message}` } });
      return;
    }
    const topLevelArray = Array.isArray(parsed) && (parsed as unknown[]).length > 0;
    const corpus =
      topLevelArray &&
      (chosen === "corpus" ||
        (chosen === "auto" &&
          (parsed as unknown[]).length >= 2 &&
          (parsed as unknown[]).every((m) => typeof m === "object" && m !== null && !Array.isArray(m))));
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
    setState({
      phase: "done",
      result,
      schema: renderIR(inferred.ir),
      assumptions: inferred.assumptions,
      corpus,
      topLevelArray,
      arrayLength: topLevelArray ? (parsed as unknown[]).length : 0,
    });
  }, []);

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const onType = (value: string) => {
    setText(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => run(value, mode), 250);
  };

  const loadExample = (make: () => unknown) => {
    const pretty = JSON.stringify(make(), null, 2);
    setText(pretty);
    setMode("auto");
    run(pretty, "auto");
  };

  const chooseMode = (m: Mode) => {
    setMode(m);
    run(text, m);
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
    if (r.profiled !== undefined) out.push({ label: "Hyperfly Profiled", bytes: per(r.profiled), kind: "full" });
    return out;
  }, [state]);

  const max = rows.length > 0 ? rows[0]!.bytes : 1;
  const done = state.phase === "done" ? state : null;

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
          onChange={(e) => onType(e.target.value)}
        />
        <div className="play-meta">
          {done?.topLevelArray ? (
            <span className="play-toggle" role="radiogroup" aria-label="how to read the top-level array">
              <label>
                <input
                  type="radio"
                  name="play-mode"
                  checked={done.corpus}
                  onChange={() => chooseMode("corpus")}
                />
                {`traffic — ${done.arrayLength} responses`}
              </label>
              <label>
                <input type="radio" name="play-mode" checked={!done.corpus} onChange={() => chooseMode("single")} />
                one response
              </label>
            </span>
          ) : (
            <span className="play-privacy">an array of responses unlocks profile training</span>
          )}
          <span className="play-privacy">nothing is uploaded — inference, training and encoding run in this tab</span>
        </div>
      </div>

      {state.phase === "error" && (
        <div className="play-error">
          {!state.error.message.startsWith(state.error.path) && (
            <span className="play-error-path">{state.error.path} </span>
          )}
          {state.error.message}
        </div>
      )}

      {done && (
        <div className="bench play-results">
          <div className="bench-head">
            <span className="bench-flag">
              {done.corpus
                ? `per message · ${done.result.messages} messages · in-sample`
                : "one response · in-sample"}
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

          <p className="bench-note play-disclosure">
            In-sample estimate: the schema — and the profile, when trained — are inferred from these exact messages
            and measured on them. Repeated strings become closed enums that would reject unseen values; held-out
            traffic and a hand-declared schema will differ. The benchmarks on the front page use declared schemas.
          </p>

          {!done.corpus && (
            <p className="bench-note">
              Paste an <em>array</em> of responses from the same route to unlock the profiled row — recurring values,
              id shapes, and column dependencies only exist across traffic, never inside one response.
            </p>
          )}

          {done.corpus && (
            <div className="play-learned">
              <p className="play-learned-head">
                what the profile learned
                {done.result.profiledArtifactBytes !== undefined && (
                  <span>
                    {" "}
                    · codec artifact {NUMBER.format(done.result.profiledArtifactBytes)} B uncompressed, fetched once
                    out of band ({NUMBER.format(done.result.profiledArtifactBytes - done.result.artifactBytes)} B of
                    it is the profile)
                    {done.result.breakEven !== undefined &&
                      ` · training pays for itself after ~${done.result.breakEven} responses, in-sample`}
                  </span>
                )}
              </p>
              {done.result.learned.length === 0 ? (
                <p className="play-learned-item">
                  nothing — this traffic has no cross-request structure worth carrying, so the profiled row would
                  equal the Hyperfly row
                </p>
              ) : (
                <ul>
                  {done.result.learned.map((l, i) => (
                    <li key={i} className="play-learned-item">
                      <code>{l.path}</code> — {l.what}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <details className="play-schema">
            <summary>inferred schema · fingerprint {done.result.fingerprint.slice(0, 8)}</summary>
            <pre>{done.schema}</pre>
            {done.assumptions.length > 0 && (
              <p className="footnote">
                never observed, assumed string: {done.assumptions.join(", ")}
              </p>
            )}
            <p className="footnote">
              Inferred from the payload alone — a real integration declares this in Zod or Pydantic. JSON is measured
              minified with JavaScript parse semantics (duplicate keys keep the last value, −0 becomes 0); gzip at
              level 6, the common edge default.
            </p>
          </details>

          {!done.result.roundTripOk && (
            <p className="play-error">
              round-trip mismatch — these numbers are not trustworthy; please report this payload shape
            </p>
          )}
        </div>
      )}
    </div>
  );
}
