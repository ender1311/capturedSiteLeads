import { z } from "zod";

export const leadName = z.string().min(1).max(200);

// Accepts bare domains ("example.com") and normalizes them to https URLs.
export const leadSiteUrl = z
  .string()
  .min(4)
  .transform((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`))
  .pipe(z.url());

export const leadPain = z.string().max(500).optional();

export const leadEmail = z.email();
