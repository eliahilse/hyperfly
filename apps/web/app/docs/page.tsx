import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "../mark";

const GITHUB = "https://github.com/eliahilse/hyperfly";
const README = `${GITHUB}/tree/main/packages/hyperfly`;
const SECTIONS = [
  ["install", "Install"],
  ["compile", "Compile a codec"],
  ["serve", "Serve it"],
  ["request-bodies", "Read request bodies"],
  ["client", "Client"],
  ["limits", "Limits"],
  ["further-reading", "Further reading"],
] as const;

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Get started with Hyperfly: compile Zod and Pydantic codecs, train a profile, and serve typed APIs with JSON fallback.",
  alternates: { canonical: "/docs" },
};

function CodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <figure className="code">
      <figcaption className="code-head">
        <span className="code-file">{label}</span>
      </figcaption>
      <pre className="code-body" tabIndex={0} aria-label={label}>
        <code>{children}</code>
      </pre>
    </figure>
  );
}

export default function DocsPage() {
  return (
    <div className="docs">
      <header className="nav">
        <Link className="nav-brand" href="/">
          <Mark size={18} />
          <span>hyperfly</span>
        </Link>
        <span className="nav-status">
          <span className="dot" aria-hidden="true" />
          docs
        </span>
        <nav className="nav-links">
          <Link href="/">home</Link>
          <Link href="/playground">playground</Link>
          <a href={GITHUB} target="_blank" rel="noopener noreferrer">
            github
          </a>
        </nav>
      </header>

      <main className="sheet">
        <section className="section" aria-labelledby="getting-started">
          <div className="section-head">
            <span className="section-index">·</span>
            <h1 className="section-title" id="getting-started">Getting started</h1>
            <p className="section-lead">
              Compile your schema once, optionally train on a route&apos;s traffic, then negotiate
              binary responses with clients that hold the codec. Everyone else gets JSON.
            </p>
          </div>
          <p className="docs-prose">
            Hyperfly is a pre-release; expect breaking changes before 1.0. This guide covers the
            first request. The <a href={`${README}#reference`}>package README</a> has the API and
            runtime reference tables.
          </p>
          <nav className="docs-toc" aria-label="On this page">
            <ol>
              {SECTIONS.map(([id, title]) => (
                <li key={id}><a href={`#${id}`}>{title}</a></li>
              ))}
            </ol>
          </nav>
        </section>

        <section className="section" id="install" aria-labelledby="install-title">
          <div className="section-head">
            <span className="section-index">01</span>
            <h2 className="section-title" id="install-title">Install</h2>
            <p className="section-lead">
              Pre-releases are published under npm&apos;s <code>next</code> tag and need
              {" "}<code>--pre</code> with pip. Zod 4 is needed only for the Zod adapter. Python&apos;s
              core package has no Pydantic dependency; use the extra for the Pydantic example below.
            </p>
          </div>
          <p className="docs-prose">
            The npm package requires Node.js 22 or later and is ESM only.
          </p>
          <CodeBlock label="terminal">{`npm install hyperfly@next zod
pip install --pre hyperfly
# With the Pydantic adapter (Pydantic >= 2.5):
pip install --pre "hyperfly[pydantic]"`}</CodeBlock>
        </section>

        <section className="section" id="compile" aria-labelledby="compile-title">
          <div className="section-head">
            <span className="section-index">02</span>
            <h2 className="section-title" id="compile-title">Compile a codec</h2>
            <p className="section-lead">
              The default plan is row. Choose columnar for arrays of records, then encode and
              decode with the same codec. Unsupported schemas fail at compile time with a path.
            </p>
          </div>
          <CodeBlock label="TypeScript · Zod">{`import { z } from "zod";
import { compile } from "hyperfly/zod";

const EventResponse = z.object({
  events: z.array(z.object({
    id: z.string(), timestamp: z.int().nonnegative(),
    kind: z.enum(["created", "updated"]),
  })),
});
const response = {
  events: [{ id: "evt_001", timestamp: 1_700_000_000, kind: "created" as const }],
};
const codec = compile(EventResponse, { plan: "columnar" });
const bytes = codec.encode(response);
const value = codec.decode(bytes);`}</CodeBlock>
          <CodeBlock label="Python · Pydantic">{`from enum import Enum
from pydantic import BaseModel, Field
from hyperfly.pydantic import compile

class Kind(str, Enum):
    created = "created"
    updated = "updated"

class Event(BaseModel):
    id: str
    timestamp: int = Field(ge=0)
    kind: Kind

class EventResponse(BaseModel):
    events: list[Event]

response = EventResponse(events=[
    Event(id="evt_001", timestamp=1_700_000_000, kind=Kind.created),
])
codec = compile(EventResponse, plan="columnar", validate=True)
data = codec.encode(response)
value = codec.decode(data)  # EventResponse; without validate=True, a dict`}</CodeBlock>
          <p className="docs-prose">
            A profile learns values that recur across responses. Supply representative samples
            from one route; the single sample here only shows the API. A new profile produces a
            new fingerprint, and the artifact ships separately from each response.
          </p>
          <CodeBlock label="TypeScript · train a profile">{`import { train } from "hyperfly";
import { toIR } from "hyperfly/zod";

const profile = train(toIR(EventResponse), [response]);
const profiled = compile(EventResponse, { plan: "columnar", profile });`}</CodeBlock>
          <CodeBlock label="Python · train a profile">{`from hyperfly import train
from hyperfly.pydantic import to_ir

samples = [response.model_dump(mode="json", by_alias=True)]
profile = train(to_ir(EventResponse), samples)
profiled = compile(EventResponse, plan="columnar", profile=profile, validate=True)`}</CodeBlock>
        </section>

        <section className="section" id="serve" aria-labelledby="serve-title">
          <div className="section-head">
            <span className="section-index">03</span>
            <h2 className="section-title" id="serve-title">Serve it</h2>
            <p className="section-lead">
              Continue from the TypeScript example with a fetch handler. Register the compiled
              codec, or use <code>profiled</code> to serve the trained version.
            </p>
          </div>
          <CodeBlock label="TypeScript · fetch handler">{`import { CodecRegistry } from "hyperfly";
import { discovery, respond } from "hyperfly/http";

const registry = new CodecRegistry([codec]);
export default {
  fetch(request: Request) {
    return discovery(request, registry) ??
      respond(request, response, registry, { onFallback: console.warn });
  },
};`}</CodeBlock>
          <p className="docs-prose">
            A client with no codec gets JSON plus <code>Hyperfly-Offer</code>. After fetching and
            registering that artifact, it advertises the fingerprint and can receive binary on
            the next request. Responses carry <code>Vary: Hyperfly-Accept, Accept</code>. If the
            encoder refuses a value under its limits (code <code>limit</code> or <code>depth</code>),
            {" "}<code>respond</code> sends it as JSON instead and calls <code>{`onFallback(error, "encoder-limit")`}</code>;
            any other encode error is thrown. See the <a href={`${README}#json-fallback`}>JSON
            fallback</a> and, for Node and Express servers, the{" "}
            <a href={`${README}#node-and-express`}>Express example</a>.
          </p>
          <p className="docs-prose">
            Put discovery behind the same authorization as the route and use a separate registry
            per tenant. See the <a href={`${README}#tenants-and-authorization`}>authorization guidance</a>
            {" "}before serving trained artifacts.
          </p>
        </section>

        <section className="section" id="request-bodies" aria-labelledby="request-bodies-title">
          <div className="section-head">
            <span className="section-index">04</span>
            <h2 className="section-title" id="request-bodies-title">Read request bodies</h2>
            <p className="section-lead">
              Bound incoming JSON and binary bytes with <code>maxBytes</code>, then forward the
              returned error response when <code>ok</code> is false; <code>reason</code> says why.
            </p>
          </div>
          <CodeBlock label="TypeScript · request body">{`import { readBody, respond } from "hyperfly/http";

async function receive(request: Request) {
  const result = await readBody(request, registry, { maxBytes: 1 << 20 });
  if (!result.ok) return result.response;
  return respond(request, result.value, registry);
}`}</CodeBlock>
          <p className="docs-prose">The first applicable rule wins:</p>
          <ol className="docs-list">
            <li><code>415</code> <code>unsupported-media-type</code>: absent Content-Type means JSON and <code>+json</code> is accepted.</li>
            <li><code>413</code> <code>too-large</code>: body exceeds <code>maxBytes</code>, counted as bytes arrive; Content-Length can reject early.</li>
            <li><code>400</code> <code>unreadable</code>: the body stream cannot be read.</li>
            <li><code>400</code> <code>malformed-json</code>: a JSON body is malformed UTF-8 or JSON.</li>
            <li><code>400</code> <code>malformed-envelope</code>: invalid binary envelope header.</li>
            <li><code>400</code> <code>codec-mismatch</code>: <code>Hyperfly-Codec</code> disagrees with the envelope fingerprint.</li>
            <li><code>415 + Hyperfly-Offer</code> <code>unknown-codec</code>: the offer is included when a codec is registered.</li>
            <li><code>400</code> <code>undecodable</code>: binary decode fails, including limits.</li>
          </ol>
        </section>

        <section className="section" id="client" aria-labelledby="client-title">
          <div className="section-head">
            <span className="section-index">05</span>
            <h2 className="section-title" id="client-title">Client</h2>
            <p className="section-lead">
              Keep a client registry between requests. The first JSON response offers a codec;
              fetching and adding it prepares the next request for binary.
            </p>
          </div>
          <CodeBlock label="TypeScript · client">{`import { CodecRegistry } from "hyperfly";
import { acceptHeader, decodeResponse, fetchArtifact } from "hyperfly/http";

const registry = new CodecRegistry();
async function getEvents(url: string) {
  const result = await fetch(url, {
    headers: { "Hyperfly-Accept": acceptHeader(registry.fingerprints) },
  });
  const bytes = new Uint8Array(await result.arrayBuffer());
  const decoded = decodeResponse(result.headers.get("content-type"), bytes, registry);
  if (decoded.kind === "unknown-codec") throw new Error("Unadvertised codec");
  const offer = result.headers.get("hyperfly-offer");
  if (decoded.kind === "json" && offer && !registry.has(offer)) {
    // an offer is advisory: a failed upgrade leaves this client on JSON, not failing the request
    const codec = await fetchArtifact(new URL(url).origin, offer).catch((error: unknown) => {
      console.warn("hyperfly artifact fetch failed", error);
      return undefined;
    });
    if (codec) registry.add(codec);
  }
  return decoded.value;
}`}</CodeBlock>
          <p className="docs-prose">
            Pass an absolute URL to <code>getEvents</code>. <code>fetchArtifact</code> compiles
            the artifact to verify its fingerprint; a 404 returns <code>undefined</code>, so the
            client stays on JSON. If <code>decodeResponse</code> reports <code>unknown-codec</code>,
            re-request without <code>Hyperfly-Accept</code> to get JSON.
          </p>
        </section>

        <section className="section" id="limits" aria-labelledby="limits-title">
          <div className="section-head">
            <span className="section-index">06</span>
            <h2 className="section-title" id="limits-title">Limits</h2>
          </div>
          <p className="docs-prose">
            Codecs bound nesting, array counts, value lengths, and two per-body budgets: the
            sum of all array counts and the sum of all decoded string and bytes lengths, each
            scaled to the body&apos;s length. Over HTTP, a value past these limits
            falls back to JSON. Limits are local to each peer, are not negotiated, and are not
            part of the fingerprint.
          </p>
          <p className="docs-prose">
            For dense routes, such as long runs of constant columns, arrays of literals, or strings
            that are mostly dictionary hits, raise them on both peers: <code>maxAmplification</code>
            {" "}for items and <code>maxByteAmplification</code> for bytes, with the{" "}
            <code>limits</code> option to <code>compile</code> and <code>fetchArtifact</code>. See the{" "}
            <a href={`${README}#limits`}>README limits reference</a> for defaults and{" "}
            <a href={`${GITHUB}/blob/main/spec/wire-v0.md#6-limits`}>wire v0 §6</a> for the rules.
          </p>
        </section>

        <section className="section" id="further-reading" aria-labelledby="further-reading-title">
          <div className="section-head">
            <span className="section-index">07</span>
            <h2 className="section-title" id="further-reading-title">Further reading</h2>
          </div>
          <ul className="docs-list">
            <li><a href={`${README}#readme`}>Package README</a>: API, limits, errors, and runtime support.</li>
            <li><a href={`${README}#errors`}>Error codes</a>: every <code>HyperflyError</code> code and its <code>cause</code>.</li>
            <li><a href={`${README}#runtime-support`}>Runtime support</a>: Node.js 22 or later, Bun, Deno, Workers, and browsers.</li>
            <li><a href={`${GITHUB}/blob/main/python/README.md`}>Python README</a>: Pydantic and Python HTTP helpers.</li>
            <li><a href={`${GITHUB}/blob/main/rust/README.md`}>Rust crate README</a>: the Rust codec.</li>
            <li><a href={`${GITHUB}/blob/main/spec/wire-v0.md`}>wire-v0</a>: envelope, primitives, and limits.</li>
            <li><a href={`${GITHUB}/blob/main/spec/plan-columnar-v5.md`}>plan-columnar-v5</a>: column layouts and profiles.</li>
            <li><a href={`${GITHUB}/blob/main/spec/negotiation-v1.md`}>negotiation-v1</a>: HTTP headers, discovery, and rotation.</li>
            <li><a href={`${GITHUB}/tree/main/spec/vectors`}>Golden vectors</a>: shared conformance fixtures.</li>
            <li><a href={`${GITHUB}/blob/main/STABILITY.md`}>Stability and versioning</a>: what 1.x keeps stable, and the <a href={`${GITHUB}/blob/main/spec/wire-v0.md#stability`}>spec&apos;s stability contract</a>.</li>
            <li><a href={`${GITHUB}/blob/main/SECURITY.md`}>Security policy</a>: how to report a vulnerability.</li>
          </ul>
        </section>
      </main>

      <footer className="footer">
        <span className="footer-brand">hyperfly</span>
        <div className="footer-links">
          <Link href="/">home</Link>
          <Link href="/playground">playground</Link>
          <a href={GITHUB} target="_blank" rel="noopener noreferrer">source</a>
          <a href={`${GITHUB}/blob/main/spec/plan-columnar-v5.md`} target="_blank" rel="noopener noreferrer">spec</a>
        </div>
      </footer>
    </div>
  );
}
