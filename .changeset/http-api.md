---
"hyperfly": minor
---

`NegotiateOptions.accept` is now `httpAccept`, `WellKnownResponse` is now `ArtifactResponse`, `FetchHandlerOptions` is now `RespondOptions`, and `onFallback` moves to `EncodeOptions` with `(error, "encoder-limit")`. JSON negotiations and `readBody` refusals carry a `reason` (`FallbackReason`, `RequestRefusal`), and `CodecRegistry<T>` types its codecs.
