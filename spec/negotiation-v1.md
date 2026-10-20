# Hyperfly negotiation — v1

Status: stable. The contract is frozen for hyperfly 1.x; see
[Stability](wire-v0.md#stability). Defines how a client and server agree to
exchange hyperfly bytes instead of JSON over HTTP, and how a client obtains an
artifact it does not yet hold. The wire format (`spec/wire-v0.md`) is
unchanged by this document.

The governing rule is inherited from the format: a peer decodes only an
artifact it holds, identified by fingerprint. Negotiation exists so that fact
is established *before* any bytes are sent, and so the failure mode is JSON
rather than an error.

## 1. Steady state

A client that holds one or more artifacts advertises their fingerprints:

```
GET /v1/events
Accept: application/vnd.hyperfly, application/json
Hyperfly-Accept: a65108e20d19c19ff525ddf4789d5ba1, 123c921f0dccfe8d25f976757766c4e1
```

`Hyperfly-Accept` is a comma-separated list of 32-character lowercase hex
fingerprints, most preferred first. A server MUST ignore entries it does not
recognize and MUST ignore malformed entries rather than failing the request.

If the server holds a codec whose fingerprint appears in the list, it MAY
answer in binary:

```
200 OK
Content-Type: application/vnd.hyperfly
Hyperfly-Codec: a65108e20d19c19ff525ddf4789d5ba1
Vary: Hyperfly-Accept, Accept
```

The body is the envelope from wire-v0 §2. The fingerprint is already inside it;
`Hyperfly-Codec` repeats it so a proxy or a log can see it without parsing the
body.

Servers MUST select the first entry in the client's list that they can serve,
so preference belongs to the client. This matters during rotation: a client
that lists a new profile before an old one moves itself over without the server
tracking who has what.

A client opts out of binary through `Accept`. A server examines at most the
first 32 media ranges, separated by commas outside quoted strings; inside a
quoted string a backslash escapes the next character (RFC 9110 quoted-pair),
so `\"` does not end the string. A range is a type/subtype with parameters.
SP and HTAB around a range, its type/subtype, each `;`, and each parameter
name and value are ignored; type and subtype compare case-insensitively. The
`q` parameter name is case-insensitive and its value follows the RFC 9110
qvalue syntax: `0`, `0.`, `0.0`, `0.00` and `0.000` are zero, any other value
that parses is non-zero, and a range whose `q` does not parse is ignored. A
range carrying any parameter other than `q`, or more than one `q`, is
ignored. Binary is refused when the most specific range present among
`application/vnd.hyperfly`, `application/*` and `*/*` (among equally specific
ranges the first listed counts) has `q` zero;
the server then MUST NOT answer in binary, whatever `Hyperfly-Accept` says,
and answers with the fallback (§2). If no range matches, or `Accept` is
absent, binary is not refused: `Hyperfly-Accept` is the opt-in, so a client
listing only `application/json` still receives binary when it advertises a
fingerprint.

## 2. Fallback

The server answers JSON when any of these hold, and none of them is an error:

- the request carries no `Hyperfly-Accept`,
- no advertised fingerprint matches a codec the server holds,
- `Accept` refuses binary (§1),
- the encoder refuses the value under its limits (wire-v0 §6),
- the server chooses not to (load, a disabled route, an operator switch).

```
200 OK
Content-Type: application/json
Hyperfly-Offer: a65108e20d19c19ff525ddf4789d5ba1
Vary: Hyperfly-Accept, Accept
```

An encoder refusal MUST be answered in JSON like any other fallback, never
with an error status. The server SHOULD record it: it marks a route whose
limits need raising on both peers.

`Hyperfly-Offer` is optional and advisory: it names an artifact the server
would have used, so a client can fetch it (§3) and upgrade itself. A client
MUST NOT treat its presence as a requirement, and a server MUST behave
identically whether or not the client acts on it.

Because the same URL can yield either representation, selected by both
`Hyperfly-Accept` and `Accept`, every response that varies MUST carry
`Vary: Hyperfly-Accept, Accept`, or a shared cache will serve one peer's
binary to another peer that cannot read it.

## 3. Artifact discovery

A server that offers binary responses SHOULD expose its artifacts:

```
GET /.well-known/hyperfly/a65108e20d19c19ff525ddf4789d5ba1
```

A pathname that does not begin with the exact, case-sensitive prefix
`/.well-known/hyperfly/` is not a discovery path. When it does, the
remainder MUST be exactly 32 ASCII hex characters, in either case, and is
matched against the lowercase fingerprint. Any other remainder, including
surrounding whitespace, a trailing slash, percent-encoded bytes, or a `?`
and query text supplied as part of the pathname, MUST yield `404`; the
lookup performs no trimming and no percent-decoding. A query string the
HTTP layer separates before lookup is not part of the pathname.

```
200 OK
Content-Type: application/json
Cache-Control: public, max-age=31536000, immutable
```

The body is the canonical artifact text (wire-v0 §5, plan §6.5). Artifacts are
content-addressed, so the response is immutable and indefinitely cacheable: a
different artifact is a different URL by construction.

A client MUST verify that the fingerprint of the text it received equals the
one it asked for, and MUST reject a mismatch. It MUST derive the artifact from
the parsed content rather than trusting the received text (plan §6.5), so a
server cannot induce a client to hash bytes it has not understood.

Unknown fingerprint: `404`. That is not an error condition for the protocol —
the client simply continues in JSON.

## 4. Requests

A client MAY send hyperfly in a request body under the same rules, reversed:

```
POST /v1/orders
Content-Type: application/vnd.hyperfly
Hyperfly-Codec: 3f9c1a...
```

A server that does not hold that fingerprint MUST answer `415 Unsupported
Media Type` with `Hyperfly-Offer` naming what it does hold, rather than
guessing. Unlike responses, there is no safe fallback for a body already sent
in a format the peer cannot read.

A server answers a request body by these rules, in order; the first rule
that applies wins:

1. The `Content-Type` essence (type and subtype, case-insensitive, parameters
   ignored) is neither `application/vnd.hyperfly` nor JSON (`application/json`
   or a `+json` suffix; an absent `Content-Type` counts as JSON):
   `415 Unsupported Media Type`. `application/vnd.hyperfly-x` is not hyperfly.
2. The body exceeds the server's request-body bound: `413 Content Too Large`.
   The bound is server configuration (implementations SHOULD default to
   1 MiB), enforced by counting bytes as they arrive; `Content-Length` serves
   only to reject early.
3. A hyperfly body is shorter than the envelope header, or its magic or major
   is wrong (wire-v0 §2): `400 Bad Request`.
4. A hyperfly body arrives with a `Hyperfly-Codec` header whose value, with
   leading and trailing SP and HTAB removed, is not exactly the envelope
   fingerprint in lowercase hex: `400`. On a JSON body the header is ignored.
5. The server does not hold the envelope fingerprint: `415` with
   `Hyperfly-Offer`, as above.
6. The hyperfly body fails to decode under the held codec, for any wire-v0
   error (limits included): `400`.
7. A JSON body is not well-formed UTF-8 JSON: `400`.

## 5. Rotation

Retraining a profile produces a new fingerprint (plan §6.6). A deployment
rotates without a cliff by holding both:

1. The server registers the new codec alongside the old one. Both fingerprints
   resolve; responses continue in whichever the client asks for.
2. Clients pick up the new artifact — from `Hyperfly-Offer`, from a build, or
   from a scheduled fetch — and list it first.
3. When traffic on the old fingerprint reaches zero, the server drops it.

A server that holds only one codec per route makes rotation a hard cutover:
every in-flight client falls back to JSON until it updates. Holding two is
what makes the fallback a transition rather than an outage.

## 6. Security

- `Hyperfly-Accept` is client-controlled input. A server MUST examine at most
  the first 32 comma-separated segments and ignore the rest; every segment
  counts toward that bound, including empty, malformed and duplicate ones. It
  MUST NOT allocate per malformed segment, so the work one request can demand
  is bounded by the 32 segments. Only SP and HTAB are trimmed, and an entry
  that is not exactly 32 lowercase hex characters after trimming is
  malformed, not normalized. Duplicates are compared after trimming and only
  the first is kept. `spec/vectors/accept.json` pins this behaviour; every
  implementation that provides HTTP negotiation runs it.
- A fingerprint is not a secret, but it does identify a schema and a trained
  dictionary. A server MUST NOT serve an artifact belonging to one tenant to
  another, and `.well-known` discovery MUST apply the same authorization as
  the routes the artifact describes.
- Whether a value is dictionary-coded is observable in response length (plan
  §6.8). Negotiation does not change that; it only makes it opt-in per client.

## 7. Stability

This document is frozen for hyperfly 1.x as wire-v0
[Stability](wire-v0.md#stability) describes. Its Additions and A future wire
version subsections allow optional headers peers ignore, new artifacts
selected by fingerprint with JSON fallback, and negotiation changes a 1.x
peer could misread only under new header names or a new media type.
