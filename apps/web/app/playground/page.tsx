import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "../mark";
import { Playground } from "./playground";

const GITHUB = "https://github.com/eliahilse/hyperfly";

export const metadata: Metadata = {
  title: "Playground",
  description:
    "Paste a JSON payload — or a whole route's traffic — and see what hyperfly does to it. Schema inference, profile training and encoding run entirely in your browser.",
  alternates: { canonical: "/playground" },
};

export default function PlaygroundPage() {
  return (
    <>
      <header className="nav">
        <Link className="nav-brand" href="/">
          <Mark size={18} />
          <span>hyperfly</span>
        </Link>
        <span className="nav-status">
          <span className="dot" aria-hidden="true" />
          playground
        </span>
        <nav className="nav-links">
          <Link href="/">home</Link>
          <a href={GITHUB} target="_blank" rel="noopener noreferrer">
            github
          </a>
        </nav>
      </header>

      <main className="sheet">
        <section className="section play-section">
          <div className="section-head">
            <span className="section-index">·</span>
            <h1 className="section-title">Your payload, measured</h1>
            <p className="section-lead">
              Paste one response to see what the schema alone removes. Paste an array of responses
              from the same route and a profile trains on it right here — dictionaries, id grammars,
              derived columns — through the same codec the benchmarks run, with an inferred schema
              standing in for a declared one.
            </p>
          </div>
          <Playground />
        </section>
      </main>

      <footer className="footer">
        <span className="footer-brand">hyperfly</span>
        <div className="footer-links">
          <Link href="/">home</Link>
          <a href={GITHUB} target="_blank" rel="noopener noreferrer">
            source
          </a>
          <a href={`${GITHUB}/blob/main/spec/plan-columnar-v5.md`} target="_blank" rel="noopener noreferrer">
            spec
          </a>
        </div>
      </footer>
    </>
  );
}
