import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],
  // Vercel's file tracing misses chromium's binary pack without this
  outputFileTracingIncludes: {
    "/api/lead": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/test-generate": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  turbopack: { root: __dirname },
};

export default nextConfig;
