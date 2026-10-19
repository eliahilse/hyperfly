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

## Releasing

1. Merged changesets collect on `main`. On every push to `main` the release
   workflow opens or updates a `chore: release` PR that applies them: versions,
   changelogs, `pyproject.toml`, `Cargo.toml`.
2. A maintainer reviews and merges that PR.
3. The merge publishes every package whose version is not yet on its registry:
   npm with provenance through trusted publishing, PyPI through trusted
   publishing, crates.io. Prerelease versions go to the npm `next` dist-tag.
   Each published version is tagged and gets a GitHub release with its
   changelog section.
