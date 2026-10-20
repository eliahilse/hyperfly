# Contributing

Read [AGENTS.md](AGENTS.md) first: it holds the rules every change follows.

## Setup

```bash
bun install                                 # Bun version from packageManager in package.json
bun run lint && bun run check-types && bun run test
pytest python/tests -q                      # after pip install "./python[test]"
cargo test --manifest-path rust/Cargo.toml
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
```

## Changesets

Every PR that changes `packages/hyperfly`, `python/` or `rust/` adds a changeset:

```bash
bun changeset          # pick the packages, the bump and write a one or two sentence summary
bun changeset --empty  # the PR changes nothing users see
```

`python/package.json` and `rust/package.json` are private manifests that carry
the PyPI and crates.io versions for Changesets. `bun run version-packages`
writes them into `pyproject.toml` (as PEP 440, `1.0.0-alpha.1` becomes
`1.0.0a1`), `Cargo.toml` and `Cargo.lock`.

The repository is in prerelease mode (`.changeset/pre.json`, tag `alpha`), so
every bump produces an `-alpha.N` version. `bun changeset pre exit` leaves it
before the first stable release.
