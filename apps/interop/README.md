# interop

A TypeScript server and a Python client speaking `spec/negotiation-v1.md` over real
HTTP. The golden vectors prove the three implementations agree on bytes; this proves
two of them agree on a conversation.

```bash
bun run build --filter=hyperfly
bun apps/interop/server.ts &
PYTHONPATH=python/src python3 apps/interop/client.py
```

The client starts holding nothing, so the exchange walks the whole protocol:

1. it asks with no `Hyperfly-Accept` and gets JSON plus a `Hyperfly-Offer`
2. it fetches that artifact from `.well-known`, derives the codec from the parsed
   content, and checks the fingerprint it computed equals the one it asked for
3. it asks again advertising that fingerprint and gets binary
4. it asserts the decoded value equals the JSON the server sent in step 1

CI runs this on every push.
