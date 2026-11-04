import type { NextConfig } from "next";

const HOMEPAGE_FIXES_FILES = [
  "./node_modules/@sparticuz/chromium/bin/**",
  "./lib/homepage-fixes/skill/template/**",
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],
  // Vercel's file tracing misses chromium's binary pack without this. Routes that run the
  // homepage-fixes pipeline also need the report template, which fillReport reads from disk.
  outputFileTracingIncludes: {
    "/api/lead": HOMEPAGE_FIXES_FILES,
    "/api/homepage-fixes": HOMEPAGE_FIXES_FILES,
    "/api/cron/homepage-fixes": HOMEPAGE_FIXES_FILES,
    "/api/test-generate": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  turbopack: { root: __dirname },
};

export default nextConfig;
