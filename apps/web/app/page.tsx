import Link from "next/link";
import { Benchmark } from "./benchmark";
import { CodeSample } from "./code-sample";
import { Mark } from "./mark";
import { Reveal } from "./reveal";
import { StreamField } from "./stream-field";

const GITHUB = "https://github.com/eliahilse/hyperfly";

const REMOVED = [
  { gone: "field names", kept: "position is the name" },
  { gone: "type descriptors", kept: "the codec is already typed" },
  { gone: "object structure", kept: "compiled into the reader" },
  { gone: "enum members", kept: "an index into a set both sides hold" },
  { gone: "value bounds", kept: "an offset from the declared minimum" },
  { gone: "optionality", kept: "one bit in a shared bitmap" },
];

const STAGES = [
  {
    index: "01",
    name: "Schema",
    body: "Zod or Pydantic in, canonical IR out. Field order, types, bounds, and enum sets become one stable description that both sides can agree on.",
    artifact: "CandleResponse → ir:8f3c91",
  },
  {
    index: "02",
    name: "Profile",
    body: "Optionally, sampled traffic for a single route: value distributions, repetition, cardinality, monotonic runs — what the data usually is, not what it could be.",
    artifact: "/v1/candles ← 1.2M samples",
  },
  {
    index: "03",
    name: "Planner",
    body: "A Rust planner picks a codec per field: entropy coding, dictionary, delta, columnar layout, or raw bytes when nothing beats raw bytes.",
    artifact: "plan · 7 columns · 4 codecs",
  },
  {
    index: "04",
    name: "Wire",
    body: "The result is an immutable codec profile — one artifact, identical behaviour on every runtime, negotiated per request.",
    artifact: "hf · v1 · fp:8cf38e4e",
  },
];

const BYTES = [
  { name: "MAGIC", size: "2", detail: "hf" },
  { name: "VER", size: "1", detail: "wire major" },
  { name: "FINGERPRINT", size: "16", detail: "SHA-256 of the codec artifact — schema, plan, parameters" },
  { name: "BODY", size: "…", detail: "the part that was actually said" },
];

const FEATURES = [
  { name: "Schema-aware", body: "Compiled from the types you already ship. No second schema language to maintain." },
  { name: "Production-trained", body: "Profiles built from observed traffic on one route, not from a guess about the average payload." },
  { name: "Rust-native", body: "One core, bound outward. The planner and the codecs are the same code everywhere." },
  { name: "Browser-ready", body: "A decode path that runs in the tab, without a proxy or a round trip to translate." },
  { name: "Transparent fallback", body: "Version negotiation up front. An unknown profile gets JSON instead of an error." },
  { name: "Reproducible", body: "Benchmarks you can run against your own payloads, not screenshots of ours." },
];

const LAYERS = [
  { tag: "adapters", body: "zod · pydantic", note: "type definitions you already wrote" },
  { tag: "ir", body: "canonical schema IR", note: "one description, content-addressed" },
  { tag: "planner", body: "codec planner — rust", note: "chooses the encoding per field" },
  { tag: "profile", body: "codec profile", note: "immutable, versioned, shippable" },
  { tag: "runtimes", body: "node · python · browser · edge", note: "identical wire format or it is a bug" },
];

export default function Home() {
  return (
    <>
      <header className="nav">
        <Link className="nav-brand" href="/">
          <Mark size={18} />
          <span>hyperfly</span>
        </Link>
        <span className="nav-status">
          <span className="dot" aria-hidden="true" />
          pre-release
        </span>
        <nav className="nav-links">
          <a href="#size">size</a>
          <a href="#pipeline">pipeline</a>
          <a href={GITHUB} target="_blank" rel="noopener noreferrer">
            github
          </a>
        </nav>
      </header>

      <main className="sheet">
        <section className="hero">
          <StreamField />
          <div className="hero-inner">
            <p className="eyebrow">binary compression · typed apis · rust core</p>
            <h1 className="wordmark">hyperfly</h1>
            <p className="tagline">Binary compression for typed APIs at the edge of entropy.</p>
            <p className="deck">
              Your schema already fixes every field name, type, and bound. Your traffic already
              reveals what the values usually look like. Hyperfly compiles both into a binary
              protocol for that exact route — and speaks JSON to anything that hasn&apos;t been told.
            </p>
            <div className="cta">
              <a className="button primary" href={GITHUB} target="_blank" rel="noopener noreferrer">
                github
                <span aria-hidden="true">↗</span>
              </a>
              <span className="button ghost" aria-disabled="true">
                docs — soon
              </span>
            </div>
          </div>
          <div className="hero-rule" aria-hidden="true" />
        </section>

        <section className="section" id="not-data">
          <Reveal>
            <div className="section-head">
              <span className="section-index">01</span>
              <h2 className="section-title">What never leaves the machine</h2>
              <p className="section-lead">
                A typed API is a contract. Everything the contract already settles is not data — it
                is repetition, sent again on every response, to a peer that could have derived it.
              </p>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <ul className="removed">
              {REMOVED.map((row) => (
                <li key={row.gone}>
                  <span className="removed-gone">{row.gone}</span>
                  <span className="removed-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="removed-kept">{row.kept}</span>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={140}>
            <p className="section-close">What remains is the part your API actually had to say.</p>
          </Reveal>
        </section>

        <section className="section" id="size">
          <Reveal>
            <div className="section-head">
              <span className="section-index">02</span>
              <h2 className="section-title">The size of a response</h2>
              <p className="section-lead">
                A general-purpose compressor rediscovers your structure on every response, from
                scratch, with no idea what the next byte is allowed to be. A compiled codec never
                has to.
              </p>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <Benchmark />
          </Reveal>

          <Reveal delay={120}>
            <p className="footnote">
              Bytes per message, averaged over 500 independent responses per route, measured
              with the TypeScript reference implementation — reproduce with `bun run bench`. The
              profile is trained on the route&apos;s own traffic, which is what a deployment does;
              it is an out-of-band artifact, and the repo reports its size and how many requests
              it takes to pay for itself (ten for events, thirty-five for orders). The Brotli row
              is q4, the level edges actually run on dynamic responses. Protobuf gets proper
              enums and int64. Corpora are synthetic but shaped like real routes: a fixed device
              fleet, a fixed product catalogue, a recurring cast of authors.
            </p>
          </Reveal>
        </section>

        <section className="section" id="pipeline">
          <Reveal>
            <div className="section-head">
              <span className="section-index">03</span>
              <h2 className="section-title">Schema in, protocol out</h2>
              <p className="section-lead">
                Four stages. The first is enough to encode. The second is what makes it fast.
              </p>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <ol className="pipeline">
              {STAGES.map((stage) => (
                <li key={stage.index} className="stage">
                  <span className="stage-index">{stage.index}</span>
                  <h3 className="stage-name">{stage.name}</h3>
                  <p className="stage-body">{stage.body}</p>
                  <span className="stage-artifact">{stage.artifact}</span>
                </li>
              ))}
            </ol>
          </Reveal>
        </section>

        <section className="section" id="wire">
          <Reveal>
            <div className="section-head">
              <span className="section-index">04</span>
              <h2 className="section-title">The envelope</h2>
              <p className="section-lead">
                Nineteen bytes of header, then the payload. The fingerprint names the entire
                codec — same schema under a different plan is a different artifact, so bytes are
                never misread, only refused.
              </p>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="wire">
              <div className="wire-cells">
                {BYTES.map((field) => (
                  <div className="wire-cell" key={field.name} data-body={field.name === "BODY" ? "" : undefined}>
                    <span className="wire-size">{field.size}</span>
                    <span className="wire-name">{field.name}</span>
                    <span className="wire-detail">{field.detail}</span>
                  </div>
                ))}
              </div>
              <span className="wire-tag">wire v0 — spec/wire-v0.md</span>
            </div>
          </Reveal>

          <Reveal delay={120}>
            <ul className="wire-notes">
              <li>
                A peer that does not hold the profile says so in the request, and gets JSON. There is
                no failure mode where the response is unreadable.
              </li>
              <li>
                Profiles are content-addressed and immutable. Retraining produces a new profile; it
                never mutates one that is already in flight.
              </li>
              <li>
                The same bytes come out of Rust, Node, Python, and the browser — or it is a bug, not
                a dialect.
              </li>
            </ul>
          </Reveal>
        </section>

        <section className="section" id="usage">
          <Reveal>
            <div className="section-head">
              <span className="section-index">05</span>
              <h2 className="section-title">Two lines at the boundary</h2>
              <p className="section-lead">
                The schema is the configuration. Compile it once, then encode and decode where you
                already serialise.
              </p>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <CodeSample />
          </Reveal>

          <Reveal delay={120}>
            <p className="footnote">Planned API. Nothing is published yet.</p>
          </Reveal>
        </section>

        <section className="section" id="surface">
          <Reveal>
            <div className="section-head">
              <span className="section-index">06</span>
              <h2 className="section-title">Properties</h2>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <ul className="features">
              {FEATURES.map((feature) => (
                <li key={feature.name}>
                  <h3>{feature.name}</h3>
                  <p>{feature.body}</p>
                </li>
              ))}
            </ul>
          </Reveal>
        </section>

        <section className="section" id="architecture">
          <Reveal>
            <div className="section-head">
              <span className="section-index">07</span>
              <h2 className="section-title">Architecture</h2>
              <p className="section-lead">
                One core, one intermediate representation, one artifact. Everything above it is a
                binding.
              </p>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="stack">
              {LAYERS.map((layer) => (
                <div className="layer" key={layer.tag}>
                  <span className="layer-tag">{layer.tag}</span>
                  <span className="layer-body">{layer.body}</span>
                  <span className="layer-note">{layer.note}</span>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section className="closing">
          <Reveal>
            <h2 className="closing-line">Make every bit fly.</h2>
            <div className="cta">
              <a className="button primary" href={GITHUB} target="_blank" rel="noopener noreferrer">
                github
                <span aria-hidden="true">↗</span>
              </a>
              <span className="button ghost" aria-disabled="true">
                benchmark playground — soon
              </span>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="footer">
        <span className="footer-brand">
          <Mark size={14} />
          hyperfly.dev
        </span>
        <span className="footer-links">
          <a href={GITHUB} target="_blank" rel="noopener noreferrer">
            source
          </a>
          <a href={`${GITHUB}/tree/main/packages/lb`} target="_blank" rel="noopener noreferrer">
            load balancer
          </a>
          <a href={`${GITHUB}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">
            apache-2.0
          </a>
          <a href="https://x.com/eliahilse" target="_blank" rel="noopener noreferrer">
            elia hilse
          </a>
        </span>
      </footer>
    </>
  );
}
