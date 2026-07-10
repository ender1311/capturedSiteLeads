import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Machine-to-machine routes keep their own auth (shared secret / HMAC signature)
const PUBLIC_PREFIXES = ["/api/auth", "/api/lead", "/api/webhook"];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return;

  if (!req.auth) {
    const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.href);
    return NextResponse.redirect(signInUrl);
  }
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)"],
};
