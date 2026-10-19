# Contributor rules

These apply to everyone who changes this repository, people and agents alike.
[CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the commands.

- **The spec is normative.** `spec/` defines the wire format; the TypeScript,
  Python and Rust implementations follow it and agree byte-for-byte on
  `spec/vectors`. A change to wire bytes changes the spec, regenerates the
  vectors and updates all three implementations in the same PR.
- **Changesets.** A PR that changes a published package (`hyperfly` on npm,
  `@hyperfly/python` for PyPI, `@hyperfly/rust` for crates.io) adds one with
  `bun changeset`. The body is a one or two sentence tl;dr of what users gain,
  with new API names in backticks, no internals and no em dashes. Use
  `bun changeset --empty` when nothing user-facing changed. CI checks both.
- **Versions.** Changesets owns every version. Never edit a version field by
  hand, including `pyproject.toml` and `Cargo.toml`.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org)
  (`feat(python): ...`, `fix(rust): ...`, `chore(ci): ...`).
- **Comments** explain what code does and why, never the history of a change.
- **Tests** are never deleted or weakened to make a change pass.
