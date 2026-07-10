import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const ALLOWED_EMAILS = ["danluk1311@gmail.com", "maggiemluk@gmail.com"];

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true, // always behind Vercel's proxy (and localhost in dev)
  providers: [Google],
  callbacks: {
    signIn({ user }) {
      return ALLOWED_EMAILS.includes(user.email?.toLowerCase() ?? "");
    },
  },
});
