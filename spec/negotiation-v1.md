# Hyperfly negotiation — v1

Status: draft. Defines how a client and server agree to exchange hyperfly bytes
instead of JSON over HTTP, and how a client obtains an artifact it does not yet
hold. The wire format (`spec/wire-v0.md`) is unchanged by this document.

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
Vary: Hyperfly-Accept
```

The body is the envelope from wire-v0 §2. The fingerprint is already inside it;
`Hyperfly-Codec` repeats it so a proxy or a log can see it without parsing the
body.

Servers MUST select the first entry in the client's list that they can serve,
so preference belongs to the client. This matters during rotation: a client
that lists a new profile before an old one moves itself over without the server
tracking who has what.

## 2. Fallback

The server answers JSON when any of these hold, and none of them is an error:

- the request carries no `Hyperfly-Accept`,
- no advertised fingerprint matches a codec the server holds,
- the server chooses not to (load, a disabled route, an operator switch).

```
200 OK
Content-Type: application/json
Hyperfly-Offer: a65108e20d19c19ff525ddf4789d5ba1
Vary: Hyperfly-Accept
```

`Hyperfly-Offer` is optional and advisory: it names an artifact the server
would have used, so a client can fetch it (§3) and upgrade itself. A client
MUST NOT treat its presence as a requirement, and a server MUST behave
identically whether or not the client acts on it.

Because the same URL can yield either representation, a response that varies
on the header MUST carry `Vary: Hyperfly-Accept`, or a shared cache will serve
one peer's binary to another peer that cannot read it.

## 3. Artifact discovery

A server that offers binary responses SHOULD expose its artifacts:

```
GET /.well-known/hyperfly/a65108e20d19c19ff525ddf4789d5ba1
```

```
200 OK
Content-Type: application/json
Cache-Control: public, max-age=31536000, immutable
```

The body is the canonical artifact text (wire-v0 §5, plan §6.3). Artifacts are
content-addressed, so the response is immutable and indefinitely cacheable: a
different artifact is a different URL by construction.

A client MUST verify that the fingerprint of the text it received equals the
one it asked for, and MUST reject a mismatch. It MUST derive the artifact from
the parsed content rather than trusting the received text (wire-v0 §7), so a
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

## 5. Rotation

Retraining a profile produces a new fingerprint (plan §6.4). A deployment
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

- `Hyperfly-Accept` is client-controlled input. A server MUST bound the number
  of entries it parses (32 is ample) and MUST NOT allocate per unrecognized
  entry.
- A fingerprint is not a secret, but it does identify a schema and a trained
  dictionary. A server MUST NOT serve an artifact belonging to one tenant to
  another, and `.well-known` discovery MUST apply the same authorization as
  the routes the artifact describes.
- Whether a value is dictionary-coded is observable in response length (plan
  §6.6). Negotiation does not change that; it only makes it opt-in per client.
