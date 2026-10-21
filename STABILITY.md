# Stability and versioning

Each package follows Semantic Versioning independently: `hyperfly` on npm,
`hyperfly` on PyPI and `hyperfly-core` on crates.io. They release from one
repository through Changesets. Their versions do not have to match.

## Public API

- TypeScript: the `hyperfly`, `hyperfly/zod` and `hyperfly/http` entry points,
  including their exported types.
- Python: the names in `hyperfly.__all__`, plus the non-underscore names in
  `hyperfly.registry`, `hyperfly.http` and `hyperfly.pydantic`.
- Rust: the public items re-exported by `hyperfly-core` in `rust/src/lib.rs`,
  including their public fields, variants and methods.

Names outside these exports and public submodule APIs are internal.
Underscore-prefixed Python names and Rust items marked `#[doc(hidden)]`
are internal.

## Releases and errors

Breaking changes to the public API require a major release. Minor releases
add API and options. Patch releases fix bugs.

Error codes are part of each package's public API. These include `limit`,
`depth`, `ir` and `fingerprint`; TypeScript and Python also expose `options`,
`validation` and `json`, and TypeScript exposes `artifact` for artifact loading. Message text is not part of the contract.
Match on the code rather than the message.

HTTP request failures are also part of the contract: the status codes
`readBody` answers with in TypeScript, and the `status` and `reason` values
Python's `RequestError` carries.
HTTP error message text is not part of the contract.

## Wire compatibility

The wire format, canonical artifact serialization and fingerprint, and
negotiation headers are frozen for all of 1.x as described in
[the spec's stability section](spec/wire-v0.md#stability).
Any 1.x encoder's bytes decode with any 1.x decoder of the same artifact,
across TypeScript, Python and Rust, subject to the receiver's decode limits.
TypeScript and Python decode packed columns by default; a Rust codec decodes
them when it is compiled with packing enabled. A decoder without packing
support (for example `pack: false` in TypeScript) rejects packed columns.

Encoder output size, the plan or columns `train` picks, and benchmark numbers
are not part of the contract. They may improve in minor releases while the
result remains valid wire format.

## Default limits

[Wire v0 section 6](spec/wire-v0.md#6-limits) defines `maxDepth`, `maxItems`,
`maxByteLength`, `maxAmplification`, `maxTotalItems`, `maxTotalBytes` and
`maxByteAmplification`. Python and Rust use the corresponding `snake_case`
names. Tightening a default decode limit is breaking and requires a major
release. Loosening a default is allowed in a minor release.

## Runtimes and deprecations

The supported minimums are Node.js 22, Python 3.10 and Rust 1.82 (the MSRV).
Raising a minimum is an exception to the breaking-change rule: it is not
treated as breaking, happens only in a minor release and is called out in
the changelog.

An API is deprecated in a minor release with a changelog note and a
replacement. It is removed no earlier than the next major release.

## Supported versions

The latest 1.x minor of each package receives fixes. The unrelated load
balancer published as `hyperfly` 0.x on npm is not supported.
See [the security policy](SECURITY.md) for vulnerability reporting and
supported security releases.
