import { permanentRedirect } from "next/navigation";

// The dashboard moved to the Beacon Frontier admin (2026-11-03): Captured Sites' page there has
// the Homepage Fixes leads, PDFs, email setup and numbers. Old bookmarks land there (308).

export const dynamic = "force-dynamic";

export default function Dashboard() {
  permanentRedirect("https://beaconfrontier.com/admin/site/capturedsites");
}
