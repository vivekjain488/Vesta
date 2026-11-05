import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@perpetua/core"],
  reactStrictMode: true,
};
export default config;
