import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@perpetua/core"],
  reactStrictMode: true,
  async rewrites() {
    const backend = process.env.BACKEND_API_URL?.trim();
    if (!backend) return [];
    const url = new URL(backend);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("BACKEND_API_URL must be an HTTP(S) origin without a path, credentials, query, or fragment");
    }
    return [{ source: "/backend/:path*", destination: `${url.origin}/:path*` }];
  },
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
