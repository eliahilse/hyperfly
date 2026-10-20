# Security policy

## Supported versions

| Package | Supported versions |
|---|---|
| `hyperfly` on npm | Latest 1.x minor |
| `hyperfly` on PyPI | Latest 1.x minor |
| `hyperfly-core` on crates.io | Latest 1.x minor |

Earlier prereleases, including `1.0.0-alpha.*` (`1.0.0a*` on PyPI), are not
supported. The unrelated npm `hyperfly` 0.x load balancer is not supported.
[Stability and versioning](STABILITY.md) defines the compatibility contract.

## Reporting a vulnerability

Report privately through [GitHub's private vulnerability reporting](https://github.com/eliahilse/hyperfly/security/advisories/new),
using "Report a vulnerability" on the Security tab. Do not open public issues
for vulnerabilities.

Include the package and version, a minimal payload and artifact or other
reproduction, and the impact.

## Scope

In scope:

- Decoder behaviour on hostile input: crashes, hangs, or memory or CPU use
  beyond the configured [wire v0 section 6 limits](spec/wire-v0.md#6-limits).
- Artifact fingerprint verification bypass in `fetchArtifact` or `loadArtifact`.
- HTTP body caps and negotiation in `readBody`, `respond` and Accept parsing,
  including the bounds in [negotiation v1 section 6](spec/negotiation-v1.md#6-security).
- Cross-implementation disagreements that let one peer accept bytes another
  rejects in a security-relevant way.

Deployments that raise or disable limits, benchmark claims and the website
are out of scope.

Fixes are released as patch versions of every affected package and published
as GitHub security advisories.
