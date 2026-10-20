# @hyperfly/rust

## 0.1.1-alpha.0

### Patch Changes

- 7e38b7c: Decoding a packed string column no longer allocates its declared size up front, so a few hostile bytes cannot force a 256 MiB allocation.
- ac04361: A per-body byte budget bounds the decoded bytes of strings and bytes values, including reconstructed values. The new limits are `max_total_bytes` and `max_byte_amplification`.
- ec9ba10: Decoding a columnar body keeps each string and enum column in one buffer until every column has decoded, so a body that fails partway through needs about half the memory it did. The encoder now refuses arrays its decoder would reject under the one-bit floor.
- c1a2b90: The `hyperfly-core` crate now ships crates.io metadata, a README with a runnable example as its crate docs, and declares Rust 1.82 as its minimum supported version.
- fbcfb1c: Decoding now charges every array against a per-body item budget, so a small hostile body is rejected in bounded time. The new `max_total_items` limit caps that budget, and the default `max_amplification` is now 32.
- 50b1b09: A literal `0` now accepts a float `0.0` or `-0.0` value on encode, matching the TypeScript and Python packages.
- 134d23f: Everything needed to build, compile and run a codec is imported from the crate root and documented there. A compiled codec's identity is read through `Codec::artifact()` and `Codec::fingerprint()`.
