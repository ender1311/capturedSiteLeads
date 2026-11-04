import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendPdfEmail } from "./mailerlite";

// fetch is faked; no MailerLite calls leave the machine.

type Call = { path: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let fail: (path: string, method: string) => boolean = () => false;

beforeEach(() => {
  calls = [];
  fail = () => false;
  vi.stubEnv("MAILERLITE_API_KEY", "ml_test");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).replace("https://connect.mailerlite.com/api", "");
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (fail(path, method)) return new Response("nope", { status: 500 });
    if (path === "/groups") return Response.json({ data: { id: "g1" } });
    if (path === "/campaigns") return Response.json({ data: { id: "c1" } });
    if (path === "/campaigns/c1") return Response.json({ data: { status: "sent" } });
    return Response.json({ data: {} });
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const deletes = () => calls.filter((c) => c.method === "DELETE");
const INPUT = { name: "Jane", email: "jane@example.com", pdfUrl: "https://p/x.pdf" };

describe("sendPdfEmail", () => {
  it("roadmap path: roadmap subject and copy, temp group deleted once sent", async () => {
    await sendPdfEmail(INPUT);
    const campaign = calls.find((c) => c.path === "/campaigns")!;
    const email = (campaign.body!.emails as { subject: string; content: string }[])[0];
    expect(email.subject).toBe("Jane, your Dream Client Roadmap is ready 📸");
    expect(email.content).toContain("View My Roadmap");
    expect(email.content).toContain("{$unsubscribe}");
    expect(deletes().map((c) => c.path)).toEqual(["/groups/g1"]);
  });

  it("custom subject and html are sent, with the unsubscribe footer added", async () => {
    await sendPdfEmail({ ...INPUT, subject: "S", html: "<html><body><div>hi</div></body></html>" });
    const email = (calls.find((c) => c.path === "/campaigns")!.body!.emails as { subject: string; content: string }[])[0];
    expect(email.subject).toBe("S");
    expect(email.content).toMatch(/^<html><body><div>hi<p[^>]*><a href="\{\$unsubscribe\}"/);
  });

  it("a polling failure after scheduling is treated as sent: no throw, group kept", async () => {
    fail = (path, method) => path === "/campaigns/c1" && method === "GET";
    await expect(sendPdfEmail(INPUT)).resolves.toBeUndefined();
    expect(calls.some((c) => c.path === "/campaigns/c1/schedule")).toBe(true);
    expect(deletes()).toHaveLength(0);
  });

  it("a scheduling failure deletes the temp group and throws", async () => {
    fail = (path) => path === "/campaigns/c1/schedule";
    await expect(sendPdfEmail(INPUT)).rejects.toThrow(/schedule/);
    expect(deletes().map((c) => c.path)).toEqual(["/groups/g1"]);
  });
});
