import { NextResponse } from "next/server";
import { auth, isAllowedEmail } from "@/auth";

// Machine-to-machine routes keep their own auth (shared secret / HMAC signature). The Beacon
// Frontier admin's data routes (/api/admin/*, /api/metrics/v1) check their bearer tokens themselves
// and answer 404 to anything else, so they never redirect to a sign-in page.
const PUBLIC_PREFIXES = ["/api/auth/", "/api/webhook/", "/api/admin/"];
// Exact paths reached by visitors on capturedsites.com (the homepage-fixes
// on-page check and the script that calls it); rate-limited and CORS-scoped.
// The homepage-fixes webhook checks LEAD_WEBHOOK_SECRET itself; the cron checks CRON_SECRET.
const PUBLIC_PATHS = new Set([
  "/api/lead",
  "/api/homepage-fixes",
  "/api/homepage-fixes/check",
  "/homepage-fixes-check.js",
  "/api/cron/homepage-fixes",
  "/api/metrics/v1",
  // The old dashboard: only a redirect to the Beacon Frontier admin now, which has its own sign-in.
  "/dashboard",
]);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  // exact match for PUBLIC_PATHS: anything not listed stays session-protected
  if (PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return;

  // Re-check the allowlist on every request: removing an email from
  // ALLOWED_EMAILS must revoke access immediately, not at JWT expiry.
  if (!req.auth || !isAllowedEmail(req.auth.user?.email)) {
    const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.href);
    return NextResponse.redirect(signInUrl);
  }
});

export const config = {
  // Exclude Next internals plus the PWA public assets (manifest, service
  // worker, icons) so they load without an auth redirect.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|.*\\.(?:svg|png|ico|webmanifest)$).*)",
  ],
};
