import protobuf from "protobufjs";

export interface ProtoCodec {
  encode(payload: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

const TO_OBJECT = { enums: String, longs: Number, defaults: true } as const;

function codec(
  root: protobuf.Root,
  typeName: string,
  toProto: (payload: unknown) => Record<string, unknown>,
  fromProto: (obj: Record<string, unknown>) => unknown,
): ProtoCodec {
  const type = root.lookupType(typeName);
  return {
    encode: (payload) => type.encode(type.fromObject(toProto(payload))).finish(),
    decode: (bytes) => fromProto(type.toObject(type.decode(bytes), TO_OBJECT) as Record<string, unknown>),
  };
}

function enumMaps(pairs: [wire: string, proto: string][]): [Record<string, string>, Record<string, string>] {
  const to: Record<string, string> = {};
  const from: Record<string, string> = {};
  for (const [wire, protoName] of pairs) {
    to[wire] = protoName;
    from[protoName] = wire;
  }
  return [to, from];
}

const [INTERVAL_TO, INTERVAL_FROM] = enumMaps([
  ["1m", "M1"], ["5m", "M5"], ["15m", "M15"], ["1h", "H1"], ["4h", "H4"], ["1d", "D1"],
]);

export function candlesProto(): ProtoCodec {
  const root = protobuf.Root.fromJSON({
    nested: {
      Interval: { values: { INTERVAL_UNSPECIFIED: 0, M1: 1, M5: 2, M15: 3, H1: 4, H4: 5, D1: 6 } },
      Candle: {
        fields: {
          t: { type: "int64", id: 1 },
          o: { type: "double", id: 2 },
          h: { type: "double", id: 3 },
          l: { type: "double", id: 4 },
          c: { type: "double", id: 5 },
          v: { type: "double", id: 6 },
          trades: { type: "int32", id: 7 },
        },
      },
      CandleResponse: {
        fields: {
          route: { type: "string", id: 1 },
          symbol: { type: "string", id: 2 },
          interval: { type: "Interval", id: 3 },
          candles: { rule: "repeated", type: "Candle", id: 4 },
        },
      },
    },
  });
  type Payload = { interval: string } & Record<string, unknown>;
  return codec(
    root,
    "CandleResponse",
    (p) => ({ ...(p as Payload), interval: INTERVAL_TO[(p as Payload).interval]! }),
    (o) => ({ ...o, interval: INTERVAL_FROM[o.interval as string]! }),
  );
}

const [STATUS_TO, STATUS_FROM] = enumMaps([
  ["online", "ONLINE"], ["offline", "OFFLINE"], ["degraded", "DEGRADED"],
  ["provisioning", "PROVISIONING"], ["decommissioned", "DECOMMISSIONED"], ["unknown", "UNKNOWN"],
]);
const [REGION_TO, REGION_FROM] = enumMaps([
  ["us-east", "US_EAST"], ["us-west", "US_WEST"], ["eu-central", "EU_CENTRAL"], ["eu-west", "EU_WEST"],
  ["ap-south", "AP_SOUTH"], ["ap-northeast", "AP_NORTHEAST"], ["sa-east", "SA_EAST"], ["af-south", "AF_SOUTH"],
]);

export function devicesProto(): ProtoCodec {
  const root = protobuf.Root.fromJSON({
    nested: {
      Status: {
        values: {
          STATUS_UNSPECIFIED: 0, ONLINE: 1, OFFLINE: 2, DEGRADED: 3,
          PROVISIONING: 4, DECOMMISSIONED: 5, UNKNOWN: 6,
        },
      },
      Region: {
        values: {
          REGION_UNSPECIFIED: 0, US_EAST: 1, US_WEST: 2, EU_CENTRAL: 3, EU_WEST: 4,
          AP_SOUTH: 5, AP_NORTHEAST: 6, SA_EAST: 7, AF_SOUTH: 8,
        },
      },
      Device: {
        fields: {
          id: { type: "string", id: 1 },
          status: { type: "Status", id: 2 },
          region: { type: "Region", id: 3 },
          battery: { type: "int32", id: 4 },
          rssi: { type: "sint32", id: 5 },
          uptimeSec: { type: "int64", id: 6 },
          tempC: { type: "double", id: 7 },
          firmwareMajor: { type: "int32", id: 8 },
          firmwareMinor: { type: "int32", id: 9 },
          alarms: { type: "int32", id: 10 },
          shadowSynced: { type: "bool", id: 11 },
          lastSeen: { type: "int64", id: 12 },
          tag: { type: "string", id: 13 },
        },
      },
      DeviceResponse: {
        fields: {
          route: { type: "string", id: 1 },
          page: { type: "int32", id: 2 },
          devices: { rule: "repeated", type: "Device", id: 3 },
        },
      },
    },
  });
  type Device = { status: string; region: string; tag: string | null } & Record<string, unknown>;
  type Payload = { devices: Device[] } & Record<string, unknown>;
  return codec(
    root,
    "DeviceResponse",
    (p) => ({
      ...(p as Payload),
      devices: (p as Payload).devices.map((d) => ({
        ...d,
        status: STATUS_TO[d.status]!,
        region: REGION_TO[d.region]!,
        // proto3 has no null; the corpus never emits "", so unset round-trips as null
        tag: d.tag ?? "",
      })),
    }),
    (o) => ({
      ...o,
      devices: (o.devices as Device[]).map((d) => ({
        ...d,
        status: STATUS_FROM[d.status]!,
        region: REGION_FROM[d.region]!,
        tag: d.tag === "" ? null : d.tag,
      })),
    }),
  );
}

const [LANG_TO, LANG_FROM] = enumMaps([
  ["en", "EN"], ["de", "DE"], ["fr", "FR"], ["es", "ES"], ["ja", "JA"],
]);

export function feedProto(): ProtoCodec {
  const root = protobuf.Root.fromJSON({
    nested: {
      Lang: { values: { LANG_UNSPECIFIED: 0, EN: 1, DE: 2, FR: 3, ES: 4, JA: 5 } },
      Author: {
        fields: {
          id: { type: "string", id: 1 },
          name: { type: "string", id: 2 },
          handle: { type: "string", id: 3 },
          verified: { type: "bool", id: 4 },
        },
      },
      Post: {
        fields: {
          id: { type: "string", id: 1 },
          author: { type: "Author", id: 2 },
          body: { type: "string", id: 3 },
          lang: { type: "Lang", id: 4 },
          likes: { type: "int32", id: 5 },
          replies: { type: "int32", id: 6 },
          reposts: { type: "int32", id: 7 },
          createdAt: { type: "int64", id: 8 },
          inReplyTo: { type: "string", id: 9 },
        },
      },
      FeedResponse: {
        fields: {
          route: { type: "string", id: 1 },
          posts: { rule: "repeated", type: "Post", id: 2 },
        },
      },
    },
  });
  type Post = { lang: string; inReplyTo: string | null } & Record<string, unknown>;
  type Payload = { posts: Post[] } & Record<string, unknown>;
  return codec(
    root,
    "FeedResponse",
    (p) => ({
      ...(p as Payload),
      posts: (p as Payload).posts.map((post) => ({
        ...post,
        lang: LANG_TO[post.lang]!,
        // ids are 16 hex chars, never "", so unset round-trips as null
        inReplyTo: post.inReplyTo ?? "",
      })),
    }),
    (o) => ({
      ...o,
      posts: (o.posts as Post[]).map((post) => ({
        ...post,
        lang: LANG_FROM[post.lang]!,
        inReplyTo: post.inReplyTo === "" ? null : post.inReplyTo,
      })),
    }),
  );
}
