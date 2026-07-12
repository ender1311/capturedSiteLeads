import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Captured Sites Leads",
    short_name: "Captured",
    description: "Lead intake, roadmap PDFs, and email engagement for Captured Sites.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#143133",
    theme_color: "#143133",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
