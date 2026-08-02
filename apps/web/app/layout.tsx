import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

const title = "Hyperfly — binary compression for typed APIs";
const description =
  "Hyperfly compiles Zod and Pydantic schemas, plus observed production traffic, into route-specific binary protocols — with transparent JSON fallback.";

export const metadata: Metadata = {
  metadataBase: new URL("https://hyperfly.dev"),
  title: {
    default: title,
    template: "%s — Hyperfly",
  },
  description,
  applicationName: "Hyperfly",
  keywords: [
    "binary compression",
    "typed APIs",
    "schema-compiled encoding",
    "entropy coding",
    "profile-guided compression",
    "Zod",
    "Pydantic",
    "Protobuf alternative",
    "MessagePack",
    "CBOR",
    "Rust",
  ],
  authors: [{ name: "Elia Hilse", url: "https://x.com/eliahilse" }],
  creator: "Elia Hilse",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "https://hyperfly.dev",
    siteName: "Hyperfly",
    title,
    description,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: title }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    creator: "@eliahilse",
    images: ["/og.png"],
  },
  icons: { icon: "/icon.svg" },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
