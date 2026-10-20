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

A future prerelease line starts with `bun changeset pre enter <tag>` and ends with
`bun changeset pre exit`.

## Releasing

1. Merged changesets collect on `main`. On every push to `main` the release
   workflow opens or updates a `chore: release` PR that applies them: versions,
   changelogs, `pyproject.toml`, `Cargo.toml`. It starts CI on that PR itself.
2. A maintainer reviews and merges that PR.
3. The merge publishes every package whose version is not yet on its registry:
   npm with provenance through trusted publishing, PyPI through trusted
   publishing, crates.io. Prerelease versions go to the npm `next` dist-tag.
   Each published version is tagged and gets a GitHub release with its
   changelog section.

Each registry publishes only when its repository variable is `true`
(`HYPERFLY_PUBLISH_NPM`, `HYPERFLY_PUBLISH_PYPI`, `HYPERFLY_PUBLISH_CRATES`),
in the order npm, PyPI, crates.io; a failure stops the registries after it.
Before turning one on, the repository needs the `npm`, `pypi` and `crates`
environments, a trusted publisher on npm and PyPI for workflow `release.yml`
with the matching environment, and a `CARGO_REGISTRY_TOKEN` secret in `crates`
for the crate's first publish (trusted publishing after that).

A rerun finishes what a failed run left: it publishes missing files, then tags
and creates GitHub releases, and never publishes a version twice. Running the
release workflow by hand with `dry_run` (the default) builds and checks every
version that still needs publishing and publishes nothing; pull requests that
change the release files run the same preflight.
