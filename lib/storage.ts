import { put } from "@vercel/blob";

export function pdfFilename(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `Dream-Client-Roadmap${slug ? `-${slug}` : ""}.pdf`;
}

// The last URL segment is what browsers use as the download filename, so it
// stays human (Dream-Client-Roadmap-Jami-Brannen.pdf) and uniqueness lives in
// the folder prefix instead.
export async function storePdf(
  pdf: Buffer,
  input: { name: string; folder?: string }
): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { url } = await put(
    `${input.folder ?? "reports"}/${unique}/${pdfFilename(input.name)}`,
    pdf,
    { access: "public", contentType: "application/pdf" }
  );
  return url;
}
