# hyperfly

Binary compression for typed APIs at the edge of entropy.

Typed APIs already know what their data can contain. Production traffic reveals what the data
usually contains. Hyperfly intends to use both to generate specialized binary protocols for a
route, instead of shipping generic JSON over a generic compressor.

Pre-release. Nothing here is benchmarked yet.

## Repository

```
spec/             wire format spec + golden vectors (the cross-language authority)
packages/hyperfly TypeScript reference implementation — core codec + zod adapter
apps/web          hyperfly.dev — landing page (Next.js on OpenNext / Cloudflare Workers)
apps/bench        private benchmark harness (JSON, gzip, Brotli baselines)
packages/lb       legacy load balancer, previously published as `hyperfly@0.1.x`
packages/tooling  shared eslint and typescript configs
```

## Development

```bash
bun install
bun run dev           # all apps
bun run build         # all packages
bun run check-types
```

## Deploy

```bash
cd apps/web && bun run deploy
```

## License

[Apache License 2.0](LICENSE)
