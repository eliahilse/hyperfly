"use client";

import { useState } from "react";

const SAMPLES = [
  {
    id: "zod",
    file: "server/candles.ts",
    source: `import { compile } from "hyperfly/zod";
import { CandleResponse } from "./schema";

const codec = compile(CandleResponse);

const bytes = codec.encode(response);
const value = codec.decode(bytes);`,
  },
  {
    id: "pydantic",
    file: "server/candles.py",
    source: `from hyperfly.pydantic import compile
from .schema import CandleResponse

codec = compile(CandleResponse)

data = codec.encode(response)
value = codec.decode(data)`,
  },
] as const;

const RULES: [RegExp, string][] = [
  [/^(?:import|from|export|const|let|return|def|class|async|await|new|as)\b/, "kw"],
  [/^"[^"]*"/, "str"],
  [/^[A-Za-z_$][\w$]*(?=\()/, "fn"],
  [/^[A-Z][\w$]*/, "type"],
  [/^[A-Za-z_$][\w$]*/, "id"],
  [/^\s+/, "ws"],
  [/^[^\sA-Za-z_$"]+/, "punct"],
];

function tokenize(source: string) {
  const tokens: { text: string; kind: string }[] = [];
  let rest = source;

  while (rest.length > 0) {
    let matched = false;
    for (const [pattern, kind] of RULES) {
      const match = pattern.exec(rest);
      if (!match) continue;
      tokens.push({ text: match[0], kind });
      rest = rest.slice(match[0].length);
      matched = true;
      break;
    }
    if (!matched) {
      tokens.push({ text: rest[0]!, kind: "punct" });
      rest = rest.slice(1);
    }
  }

  return tokens;
}

export function CodeSample() {
  const [index, setIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const sample = SAMPLES[index]!;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sample.source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code">
      <div className="code-head">
        <div className="code-tabs" role="tablist" aria-label="Language">
          {SAMPLES.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              className="code-tab"
              data-active={i === index ? "" : undefined}
              onClick={() => setIndex(i)}
            >
              {item.id}
            </button>
          ))}
        </div>
        <span className="code-file">{sample.file}</span>
        <button type="button" className="code-copy" onClick={copy}>
          {copied ? "copied" : "copy"}
        </button>
      </div>

      <pre className="code-body">
        <code>
          {tokenize(sample.source).map((token, i) => (
            <span key={i} className={`t-${token.kind}`}>
              {token.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
