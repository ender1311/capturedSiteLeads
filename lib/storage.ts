import { put } from "@vercel/blob";

export async function storePdf(pdf: Buffer, email: string): Promise<string> {
  const slug = email.split("@")[0].replace(/[^a-z0-9]/gi, "-").toLowerCase();
  const { url } = await put(`reports/redesign-${slug}-${Date.now()}.pdf`, pdf, {
    access: "public",
    contentType: "application/pdf",
  });
  return url;
}
