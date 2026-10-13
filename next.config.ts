import type { NextConfig } from "next";

// Static export: the app is 100% client-side, images never leave the browser.
const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
};

export default nextConfig;
