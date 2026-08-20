import { z } from "zod";
import { intIn, mulberry32, pick } from "../prng.js";

export const OrderResponse = z.object({
  route: z.literal("order"),
  id: z.string(),
  status: z.enum(["pending", "paid", "packed", "shipped", "delivered", "refunded"]),
  currency: z.enum(["USD", "EUR", "GBP", "JPY", "CHF"]),
  customer: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    tier: z.enum(["free", "standard", "plus", "enterprise"]),
  }),
  shipping: z.object({
    country: z.enum(["US", "GB", "DE", "FR", "JP", "CA", "AU", "NL"]),
    city: z.string(),
    postcode: z.string(),
  }),
  items: z.array(
    z.object({
      sku: z.string(),
      title: z.string(),
      qty: z.number().int().min(1).max(20),
      unitPrice: z.number(),
      taxRate: z.number(),
    }),
  ),
  subtotal: z.number(),
  tax: z.number(),
  total: z.number(),
  placedAt: z.number().int().min(0),
  note: z.string().nullable(),
});

const PRODUCT_COUNT = 120;
const CUSTOMER_COUNT = 200;

const ADJECTIVES = [
  "Wireless", "Steel", "Organic", "Compact", "Premium", "Vintage", "Portable", "Ceramic",
  "Leather", "Digital", "Rustic", "Modern", "Ultra", "Classic", "Eco",
] as const;

const NOUNS = [
  "Mouse", "Backpack", "Kettle", "Speaker", "Notebook", "Charger", "Sneakers", "Lamp",
  "Blanket", "Headphones", "Wallet", "Bottle", "Camera", "Chair", "Desk", "Mug",
  "Jacket", "Watch", "Keyboard", "Tent",
] as const;

const TAX_RATES = [0, 0.05, 0.07, 0.08, 0.1, 0.15, 0.19, 0.2, 0.21] as const;

const FIRST_NAMES = [
  "Olivia", "Liam", "Emma", "Noah", "Ava", "Ethan", "Sophia", "Mason",
  "Isabella", "Lucas", "Mia", "Elijah", "Amelia", "James", "Harper", "Benjamin",
] as const;

const LAST_NAMES = [
  "Garcia", "Muller", "Nguyen", "Smith", "Rossi", "Dubois", "Kowalski", "Tanaka",
  "Silva", "Andersson", "Kim", "Novak", "Haddad", "Fischer", "Costa", "Ivanov",
] as const;

const EMAIL_DOMAINS = ["gmail.com", "outlook.com", "yahoo.com", "icloud.com", "protonmail.com", "corp-mail.com"] as const;

const TIERS_WEIGHTED = ["free", "free", "free", "standard", "standard", "standard", "plus", "plus", "enterprise"] as const;

const STATUSES_WEIGHTED = [
  "pending", "paid", "paid", "paid", "packed", "packed", "shipped", "shipped", "shipped",
  "delivered", "delivered", "delivered", "delivered", "refunded",
] as const;

const CURRENCIES_WEIGHTED = ["USD", "USD", "USD", "EUR", "EUR", "GBP", "JPY", "CHF"] as const;

const CITIES = [
  { city: "New York", postcode: "10001", country: "US" },
  { city: "Los Angeles", postcode: "90001", country: "US" },
  { city: "Chicago", postcode: "60601", country: "US" },
  { city: "Austin", postcode: "73301", country: "US" },
  { city: "Seattle", postcode: "98101", country: "US" },
  { city: "London", postcode: "EC1A 1BB", country: "GB" },
  { city: "Manchester", postcode: "M1 1AE", country: "GB" },
  { city: "Birmingham", postcode: "B1 1AA", country: "GB" },
  { city: "Leeds", postcode: "LS1 1AA", country: "GB" },
  { city: "Bristol", postcode: "BS1 1AA", country: "GB" },
  { city: "Berlin", postcode: "10115", country: "DE" },
  { city: "Munich", postcode: "80331", country: "DE" },
  { city: "Hamburg", postcode: "20095", country: "DE" },
  { city: "Cologne", postcode: "50667", country: "DE" },
  { city: "Frankfurt", postcode: "60306", country: "DE" },
  { city: "Paris", postcode: "75001", country: "FR" },
  { city: "Lyon", postcode: "69001", country: "FR" },
  { city: "Marseille", postcode: "13001", country: "FR" },
  { city: "Toulouse", postcode: "31000", country: "FR" },
  { city: "Nice", postcode: "06000", country: "FR" },
  { city: "Tokyo", postcode: "100-0001", country: "JP" },
  { city: "Osaka", postcode: "530-0001", country: "JP" },
  { city: "Kyoto", postcode: "600-8216", country: "JP" },
  { city: "Yokohama", postcode: "220-0011", country: "JP" },
  { city: "Nagoya", postcode: "460-0008", country: "JP" },
  { city: "Toronto", postcode: "M5H 2N2", country: "CA" },
  { city: "Vancouver", postcode: "V6B 1A1", country: "CA" },
  { city: "Montreal", postcode: "H2Y 1C6", country: "CA" },
  { city: "Calgary", postcode: "T2P 1J9", country: "CA" },
  { city: "Ottawa", postcode: "K1P 1J1", country: "CA" },
  { city: "Sydney", postcode: "2000", country: "AU" },
  { city: "Melbourne", postcode: "3000", country: "AU" },
  { city: "Brisbane", postcode: "4000", country: "AU" },
  { city: "Perth", postcode: "6000", country: "AU" },
  { city: "Adelaide", postcode: "5000", country: "AU" },
  { city: "Amsterdam", postcode: "1012 AB", country: "NL" },
  { city: "Rotterdam", postcode: "3011 AA", country: "NL" },
  { city: "The Hague", postcode: "2511 CV", country: "NL" },
  { city: "Utrecht", postcode: "3511 LN", country: "NL" },
  { city: "Eindhoven", postcode: "5611 AZ", country: "NL" },
] as const;

const NOTES = [
  "Please deliver after 6pm.",
  "Leave with concierge.",
  "Gift wrap requested.",
  "Fragile - handle with care.",
  "Customer requested expedited processing.",
  "Address verified by support.",
  null, null, null, null, null, null, null, null, null, null, null, null, null, null,
] as const;

type Product = { sku: string; title: string; unitPrice: number; taxRate: number };
type Customer = { id: string; name: string; email: string; tier: (typeof TIERS_WEIGHTED)[number] };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function skewedIndex(rng: () => number, length: number): number {
  return Math.min(length - 1, Math.floor(rng() ** 2 * length));
}

function skewedPick<T>(rng: () => number, items: readonly T[]): T {
  return items[skewedIndex(rng, items.length)]!;
}

function buildProducts(rng: () => number): Product[] {
  const products: Product[] = [];
  const used = new Set<string>();
  while (products.length < PRODUCT_COUNT) {
    const title = `${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)}`;
    if (used.has(title)) continue;
    used.add(title);
    products.push({
      sku: `SKU-${String(products.length).padStart(5, "0")}`,
      title,
      unitPrice: round2(3 + rng() * 297),
      taxRate: pick(rng, TAX_RATES),
    });
  }
  return products;
}

function buildCustomers(rng: () => number): Customer[] {
  const customers: Customer[] = [];
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const domain = pick(rng, EMAIL_DOMAINS);
    customers.push({
      id: `cus-${String(i).padStart(5, "0")}`,
      name: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@${domain}`,
      tier: pick(rng, TIERS_WEIGHTED),
    });
  }
  return customers;
}

function pickProducts(rng: () => number, products: readonly Product[], n: number): Product[] {
  const chosen: Product[] = [];
  const used = new Set<number>();
  while (chosen.length < n) {
    const idx = skewedIndex(rng, products.length);
    if (used.has(idx)) continue;
    used.add(idx);
    chosen.push(products[idx]!);
  }
  return chosen;
}

export function ordersCorpus(count: number, seed: number): z.output<typeof OrderResponse>[] {
  const rng = mulberry32(seed);
  const products = buildProducts(rng);
  const customers = buildCustomers(rng);
  const base = 1755700000000;
  const orders: z.output<typeof OrderResponse>[] = [];
  for (let i = 0; i < count; i++) {
    const customer = skewedPick(rng, customers);
    const location = skewedPick(rng, CITIES);
    const itemCount = intIn(rng, 2, 8);
    const items = pickProducts(rng, products, itemCount).map((p) => ({
      sku: p.sku,
      title: p.title,
      qty: intIn(rng, 1, 20),
      unitPrice: p.unitPrice,
      taxRate: p.taxRate,
    }));

    let subtotal = 0;
    let tax = 0;
    for (const item of items) {
      const lineSubtotal = round2(item.unitPrice * item.qty);
      const lineTax = round2(lineSubtotal * item.taxRate);
      subtotal = round2(subtotal + lineSubtotal);
      tax = round2(tax + lineTax);
    }
    const total = round2(subtotal + tax);

    orders.push({
      route: "order",
      id: `ord-${String(intIn(rng, 0, 9999)).padStart(4, "0")}-${String(i).padStart(6, "0")}`,
      status: pick(rng, STATUSES_WEIGHTED),
      currency: pick(rng, CURRENCIES_WEIGHTED),
      customer,
      shipping: {
        country: location.country,
        city: location.city,
        postcode: location.postcode,
      },
      items,
      subtotal,
      tax,
      total,
      placedAt: base - intIn(rng, 0, 7776000000),
      note: pick(rng, NOTES),
    });
  }
  return orders;
}
