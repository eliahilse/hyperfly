# hyperfly

Global load balancer on Cloudflare Workers. Geo-aware routing with automatic read/write separation - reads go to the nearest replica, writes go to primary.

## Install

```bash
npm install hyperfly
```

## Quick Start

```ts
import { Hyperfly } from "hyperfly";

export default new Hyperfly({
  origins: [
    { url: "https://us.api.com", regions: ["NA", "SA"] },
    { url: "https://eu.api.com", regions: ["EU", "AF"] },
    { url: "https://ap.api.com", regions: ["AS", "OC"] },
  ],
});
```

## Configuration

### Origins

Origins can be simple strings or objects with options:

```ts
new Hyperfly({
  origins: [
    "https://api.com",
    { url: "https://us.api.com", regions: ["NA"] },
    { url: "https://primary.db.com", write: true },
  ],
});
```

**Regions** use Cloudflare continent codes: `AF`, `AN`, `AS`, `EU`, `NA`, `OC`, `SA`

### Strategy

```ts
new Hyperfly({
  origins: [...],
  strategy: "geo",
});

new Hyperfly({
  origins: [...],
  strategy: "random",
});
```

### Read/Write Separation

Mark origins with `write: true` to receive write operations:

```ts
new Hyperfly({
  origins: [
    { url: "https://replica-1.db.com" },
    { url: "https://replica-2.db.com" },
    { url: "https://primary.db.com", write: true },
  ],
});
```

- `GET`, `HEAD`, `OPTIONS` → read origins
- `POST`, `PUT`, `PATCH`, `DELETE` → write origins

### Failover

Enable automatic failover when origins fail:

```ts
new Hyperfly({
  origins: [...],
  failover: true,
});

new Hyperfly({
  origins: [...],
  failover: {
    maxRetries: 3,
    statusCodes: [500, 502, 503],
    timeout: 5000,
  },
});
```

Failover triggers on:
- Network errors (connection refused, DNS failure, etc.)
- Timeout exceeded
- Configured status codes

Write operations only failover to other write origins.

## Types

```ts
interface Origin {
  url: string;
  regions?: string[];
  write?: boolean;
}

interface FailoverConfig {
  maxRetries?: number;
  statusCodes?: number[];
  timeout?: number;
}

interface HyperflyConfig {
  origins: (string | Origin)[];
  strategy?: "geo" | "random";
  failover?: FailoverConfig | boolean;
}
```

## License

[Elastic License 2.0](LICENSE)
