import { NextResponse } from "next/server";
import { auth, isAllowedEmail } from "@/auth";

// Machine-to-machine routes keep their own auth (shared secret / HMAC signature)
const PUBLIC_PREFIXES = ["/api/auth/", "/api/webhook/"];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  // exact match only — /api/leads/* (dashboard CRUD) must stay session-protected
  if (pathname === "/api/lead" || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return;

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
