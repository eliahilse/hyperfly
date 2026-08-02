import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://hyperfly.dev/sitemap.xml",
    host: "https://hyperfly.dev",
  };
}
