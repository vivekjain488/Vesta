import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@perpetua/core"],
  reactStrictMode: true,
  async redirects() {
    // Wallet challenges and SameSite cookies use localhost in the local setup.
    // Canonicalize the other common loopback address before the browser signs in.
    return process.env.NODE_ENV === "development" ? [{
      source: "/:path*",
      has: [{ type: "host", value: "127\\.0\\.0\\.1" }],
      destination: "http://localhost:3000/:path*",
      permanent: false,
    }] : [];
  },
};
export default config;
