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

const [ORDER_STATUS_TO, ORDER_STATUS_FROM] = enumMaps([
  ["pending", "PENDING"], ["paid", "PAID"], ["packed", "PACKED"],
  ["shipped", "SHIPPED"], ["delivered", "DELIVERED"], ["refunded", "REFUNDED"],
]);
const [CURRENCY_TO, CURRENCY_FROM] = enumMaps([
  ["USD", "USD"], ["EUR", "EUR"], ["GBP", "GBP"], ["JPY", "JPY"], ["CHF", "CHF"],
]);
const [TIER_TO, TIER_FROM] = enumMaps([
  ["free", "FREE"], ["standard", "STANDARD"], ["plus", "PLUS"], ["enterprise", "ENTERPRISE"],
]);
const [COUNTRY_TO, COUNTRY_FROM] = enumMaps([
  ["US", "US"], ["GB", "GB"], ["DE", "DE"], ["FR", "FR"], ["JP", "JP"], ["CA", "CA"], ["AU", "AU"], ["NL", "NL"],
]);

export function ordersProto(): ProtoCodec {
  const root = protobuf.Root.fromJSON({
    nested: {
      OrderStatus: {
        values: {
          ORDER_STATUS_UNSPECIFIED: 0, PENDING: 1, PAID: 2, PACKED: 3,
          SHIPPED: 4, DELIVERED: 5, REFUNDED: 6,
        },
      },
      Currency: { values: { CURRENCY_UNSPECIFIED: 0, USD: 1, EUR: 2, GBP: 3, JPY: 4, CHF: 5 } },
      Tier: { values: { TIER_UNSPECIFIED: 0, FREE: 1, STANDARD: 2, PLUS: 3, ENTERPRISE: 4 } },
      Country: {
        values: {
          COUNTRY_UNSPECIFIED: 0, US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, AU: 7, NL: 8,
        },
      },
      Customer: {
        fields: {
          id: { type: "string", id: 1 },
          name: { type: "string", id: 2 },
          email: { type: "string", id: 3 },
          tier: { type: "Tier", id: 4 },
        },
      },
      Shipping: {
        fields: {
          country: { type: "Country", id: 1 },
          city: { type: "string", id: 2 },
          postcode: { type: "string", id: 3 },
        },
      },
      Item: {
        fields: {
          sku: { type: "string", id: 1 },
          title: { type: "string", id: 2 },
          qty: { type: "int32", id: 3 },
          unitPrice: { type: "double", id: 4 },
          taxRate: { type: "double", id: 5 },
        },
      },
      Order: {
        fields: {
          route: { type: "string", id: 1 },
          id: { type: "string", id: 2 },
          status: { type: "OrderStatus", id: 3 },
          currency: { type: "Currency", id: 4 },
          customer: { type: "Customer", id: 5 },
          shipping: { type: "Shipping", id: 6 },
          items: { rule: "repeated", type: "Item", id: 7 },
          subtotal: { type: "double", id: 8 },
          tax: { type: "double", id: 9 },
          total: { type: "double", id: 10 },
          placedAt: { type: "int64", id: 11 },
          note: { type: "string", id: 12 },
        },
      },
    },
  });
  type Customer = { tier: string } & Record<string, unknown>;
  type Shipping = { country: string } & Record<string, unknown>;
  type Payload = {
    status: string;
    currency: string;
    customer: Customer;
    shipping: Shipping;
    note: string | null;
  } & Record<string, unknown>;
  return codec(
    root,
    "Order",
    (p) => ({
      ...(p as Payload),
      status: ORDER_STATUS_TO[(p as Payload).status]!,
      currency: CURRENCY_TO[(p as Payload).currency]!,
      customer: { ...(p as Payload).customer, tier: TIER_TO[(p as Payload).customer.tier]! },
      shipping: { ...(p as Payload).shipping, country: COUNTRY_TO[(p as Payload).shipping.country]! },
      // notes are full sentences or null; the corpus never emits "", so unset round-trips as null
      note: (p as Payload).note ?? "",
    }),
    (o) => ({
      ...o,
      status: ORDER_STATUS_FROM[o.status as string]!,
      currency: CURRENCY_FROM[o.currency as string]!,
      customer: { ...(o.customer as Customer), tier: TIER_FROM[(o.customer as Customer).tier]! },
      shipping: { ...(o.shipping as Shipping), country: COUNTRY_FROM[(o.shipping as Shipping).country]! },
      note: o.note === "" ? null : o.note,
    }),
  );
}

const [EVENT_TYPE_TO, EVENT_TYPE_FROM] = enumMaps([
  ["user.login", "USER_LOGIN"], ["user.logout", "USER_LOGOUT"],
  ["file.upload", "FILE_UPLOAD"], ["file.delete", "FILE_DELETE"],
  ["billing.charge", "BILLING_CHARGE"], ["billing.refund", "BILLING_REFUND"],
  ["project.create", "PROJECT_CREATE"], ["project.archive", "PROJECT_ARCHIVE"],
  ["member.invite", "MEMBER_INVITE"], ["member.remove", "MEMBER_REMOVE"],
]);
const [RESOURCE_TYPE_TO, RESOURCE_TYPE_FROM] = enumMaps([
  ["user", "USER"], ["file", "FILE"], ["project", "PROJECT"],
  ["invoice", "INVOICE"], ["member", "MEMBER"], ["apikey", "APIKEY"],
]);

export function eventsProto(): ProtoCodec {
  const root = protobuf.Root.fromJSON({
    nested: {
      EventType: {
        values: {
          EVENT_TYPE_UNSPECIFIED: 0, USER_LOGIN: 1, USER_LOGOUT: 2, FILE_UPLOAD: 3, FILE_DELETE: 4,
          BILLING_CHARGE: 5, BILLING_REFUND: 6, PROJECT_CREATE: 7, PROJECT_ARCHIVE: 8,
          MEMBER_INVITE: 9, MEMBER_REMOVE: 10,
        },
      },
      ResourceType: {
        values: {
          RESOURCE_TYPE_UNSPECIFIED: 0, USER: 1, FILE: 2, PROJECT: 3, INVOICE: 4, MEMBER: 5, APIKEY: 6,
        },
      },
      Region: {
        values: {
          REGION_UNSPECIFIED: 0, US_EAST: 1, US_WEST: 2, EU_CENTRAL: 3, EU_WEST: 4,
          AP_SOUTH: 5, AP_NORTHEAST: 6, SA_EAST: 7, AF_SOUTH: 8,
        },
      },
      Event: {
        fields: {
          id: { type: "string", id: 1 },
          type: { type: "EventType", id: 2 },
          actorId: { type: "string", id: 3 },
          actorEmail: { type: "string", id: 4 },
          resourceId: { type: "string", id: 5 },
          resourceType: { type: "ResourceType", id: 6 },
          ip: { type: "string", id: 7 },
          userAgent: { type: "string", id: 8 },
          region: { type: "Region", id: 9 },
          durationMs: { type: "int32", id: 10 },
          ok: { type: "bool", id: 11 },
          at: { type: "int64", id: 12 },
        },
      },
      EventsResponse: {
        fields: {
          route: { type: "string", id: 1 },
          cursor: { type: "string", id: 2 },
          events: { rule: "repeated", type: "Event", id: 3 },
        },
      },
    },
  });
  type Event = { type: string; resourceType: string; region: string } & Record<string, unknown>;
  type Payload = { cursor: string | null; events: Event[] } & Record<string, unknown>;
  return codec(
    root,
    "EventsResponse",
    (p) => ({
      ...(p as Payload),
      // cursors are 16 hex chars or absent; the corpus never emits "", so unset round-trips as null
      cursor: (p as Payload).cursor ?? "",
      events: (p as Payload).events.map((e) => ({
        ...e,
        type: EVENT_TYPE_TO[e.type]!,
        resourceType: RESOURCE_TYPE_TO[e.resourceType]!,
        region: REGION_TO[e.region]!,
      })),
    }),
    (o) => ({
      ...o,
      cursor: o.cursor === "" ? null : o.cursor,
      events: (o.events as Event[]).map((e) => ({
        ...e,
        type: EVENT_TYPE_FROM[e.type]!,
        resourceType: RESOURCE_TYPE_FROM[e.resourceType]!,
        region: REGION_FROM[e.region]!,
      })),
    }),
  );
}
