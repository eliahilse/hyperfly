import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "@takumi-rs/image-response";

const GLYPHS = ["{", "}", ":", ",", '"', "[", "]", "0", "1", "A", "F", "3", "E"];
const COLS = 60;
const ROWS = 26;
const CELL_W = 20;
const CELL_H = 24;

const OUT = join(import.meta.dir, "..", "public", "og.png");

const FONTS = [
  { name: "GeistSans", path: "geist/dist/fonts/geist-sans/Geist-Medium.woff2" },
  { name: "GeistMono", path: "geist/dist/fonts/geist-mono/GeistMono-Regular.woff2" },
];

/** geist's exports map blocks deep paths under Node, so read the files directly. */
function loadFont(relative: string): Uint8Array | null {
  for (const base of ["node_modules", "../../node_modules", "../node_modules"]) {
    const candidate = join(process.cwd(), base, relative);
    if (existsSync(candidate)) return new Uint8Array(readFileSync(candidate));
  }
  return null;
}

function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

function fbm(x: number, y: number): number {
  let value = 0;
  let amplitude = 0.5;
  let px = x;
  let py = y;
  for (let i = 0; i < 4; i++) {
    value += amplitude * noise(px, py);
    px *= 2.03;
    py *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}

/** The same contracting duct as the live hero, sampled once per character cell. */
function fieldAt(col: number, row: number) {
  const x = col / COLS;
  const y = 1 - row / ROWS;

  const axis = 0.62 + (0.44 - 0.62) * x;
  const throat = 0.4 + (0.12 - 0.4) * Math.min(1, Math.max(0, (x - 0.02) / 0.92));
  const lane = (y - axis) / throat;
  const duct = 1 - Math.min(1, Math.max(0, (Math.abs(lane) - 0.62) / 0.38));

  const flow = fbm(x * 2.6, lane * 1.7 + 4);
  const density = 0.46 + 0.54 * Math.min(1, Math.max(0, (x - 0.05) / 0.85));
  const core = Math.min(1, Math.max(0, flow * 1.55 - 0.34)) * duct * density;

  const shedFade = 1 - Math.min(1, Math.max(0, (x - 0.06) / 0.5));
  const shed =
    Math.min(1, Math.max(0, fbm(x * 3.4, y * 7) * 1.3 - 0.62)) * shedFade * (1 - duct) * 0.55;

  const dx = (x - 0.28) / 0.46;
  const dy = (y - 0.5) / 0.46;
  const clearing = Math.min(1, Math.max(0, (Math.sqrt(dx * dx + dy * dy) - 0.78) / 0.55));

  const edge = Math.min(1, Math.max(0, (x - 0.05) / 0.08));

  return { intensity: Math.min(1, (core * 1.25 + shed) * clearing * edge), x };
}

function card(fonts: { name: string; data: Uint8Array }[]) {
  const cells = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const { intensity, x } = fieldAt(col, row);
      if (intensity < 0.07) continue;
      const compiled = x > 0.42;
      const pool = compiled ? GLYPHS.slice(7) : GLYPHS.slice(0, 7);
      const glyph = pool[Math.floor(hash(col, row) * pool.length)]!;
      const tint = compiled ? "92, 214, 250" : "150, 160, 180";
      cells.push(
        <div
          key={`${col}-${row}`}
          style={{
            position: "absolute",
            left: col * CELL_W,
            top: row * CELL_H,
            width: CELL_W,
            height: CELL_H,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "GeistMono",
            fontSize: 15,
            color: `rgba(${tint}, ${(0.1 + intensity * 0.5).toFixed(3)})`,
          }}
        >
          {glyph}
        </div>,
      );
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          backgroundColor: "#000",
          fontFamily: "GeistSans",
        }}
      >
        <div style={{ position: "absolute", inset: 0, display: "flex" }}>{cells}</div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "0 72px",
          }}
        >
          <div
            style={{
              fontFamily: "GeistMono",
              fontSize: 19,
              letterSpacing: 4,
              color: "rgba(255,255,255,0.36)",
              marginBottom: 26,
            }}
          >
            BINARY COMPRESSION · TYPED APIS · RUST CORE
          </div>
          <div style={{ fontSize: 128, color: "#fff", letterSpacing: -6, lineHeight: 1 }}>
            hyperfly
          </div>
          <div
            style={{
              fontSize: 38,
              color: "rgba(255,255,255,0.74)",
              letterSpacing: -1,
              marginTop: 28,
              maxWidth: 760,
            }}
          >
            Binary compression for typed APIs at the edge of entropy.
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 44 }}>
            {[
              { label: "JSON", width: 300, color: "rgba(255,255,255,0.14)" },
              { label: "BROTLI", width: 150, color: "rgba(255,255,255,0.22)" },
              { label: "HYPERFLY", width: 62, color: "rgba(92,214,250,0.75)" },
            ].map((bar) => (
              <div key={bar.label} style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <div style={{ display: "flex", width: bar.width, height: 12, backgroundColor: bar.color }} />
                <div
                  style={{
                    fontFamily: "GeistMono",
                    fontSize: 14,
                    letterSpacing: 2,
                    color: "rgba(255,255,255,0.42)",
                  }}
                >
                  {bar.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, format: "png", fonts },
  );
}

const fonts = FONTS.map((font) => {
  const data = loadFont(font.path);
  if (!data) throw new Error(`font not found: ${font.path} — og would render in a fallback face`);
  return { name: font.name, data };
});

const bytes = new Uint8Array(await card(fonts).arrayBuffer());
if (bytes.length < 1000) throw new Error(`og render produced ${bytes.length} bytes`);
await Bun.write(OUT, bytes);
console.log(`wrote ${OUT} (${bytes.length} bytes)`);
