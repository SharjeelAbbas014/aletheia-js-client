# @aletheia/sdk

This package supports both remote HTTP usage and local-first sidecar usage against the Temporal Memory engine.

## Local-first

```js
import { AletheiaClient } from "@aletheia/sdk";

const client = await AletheiaClient.fromLocal();
await client.ingest({
  entityId: "user-123",
  text: "I prefer pourover coffee."
});
const hits = await client.query("What coffee do I prefer?", {
  entityId: "user-123"
});
```

## Cloud

```js
import { AletheiaClient } from "@aletheia/sdk";

const client = AletheiaClient.fromCloud(
  "http://143.110.246.15:3000",
  "XXX1111AAA"
);
```

## Binary resolution

The local manager resolves the engine in this order:

1. Explicit `binaryPath`
2. `ALETHEIA_ENGINE_BINARY` or `TEMPORAL_MEMORY_ENGINE_BINARY`
3. Repo-local `target/release/temporal_memory` or `target/debug/temporal_memory`
4. Cached binary in `ALETHEIA_ENGINE_CACHE_DIR`
5. Manifest download from `ALETHEIA_ENGINE_MANIFEST_URL`
