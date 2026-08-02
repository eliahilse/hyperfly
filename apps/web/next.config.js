import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@takumi-rs/image-response"],
};

initOpenNextCloudflareForDev();

export default nextConfig;
