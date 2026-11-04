import { afterEach, describe, expect, it, vi } from "vitest";
import { checkEmail, checkWebsite, withDeadline } from "./validate";

const dnsErr = (code: string) => Object.assign(new Error(code), { code });

const mailOk = {
  resolveMx: async () => [{ exchange: "mx.example.com", priority: 10 }],
  resolve4: async () => ["93.184.216.34"],
};

describe("withDeadline", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the value when the promise settles first", async () => {
    vi.useFakeTimers();
    const p = withDeadline(new Promise<string>((r) => setTimeout(() => r("done"), 100)), 2500, "late");
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe("done");
  });

  it("returns onTimeout once the deadline passes", async () => {
    vi.useFakeTimers();
    let settled: string | undefined;
    const p = withDeadline(new Promise<string>(() => {}), 2500, "late").then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(2499);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe("late");
  });
});

describe("checkEmail", () => {
  it("bad_syntax", async () => {
    for (const e of ["", "bob", "bob@", "bob@gmail", "bob @gmail.com"]) {
      const r = await checkEmail(e, mailOk);
      expect(r).toEqual({ ok: false, code: "bad_syntax", message: "That email doesn't look quite right. Mind checking it?" });
    }
  });

  it("ok when the domain has MX records", async () => {
    expect(await checkEmail(" Bob@Example.com ", mailOk)).toEqual({ ok: true, code: "ok" });
  });

  it("falls back to an A record when there is no MX", async () => {
    const r = await checkEmail("bob@example.com", {
      resolveMx: async () => { throw dnsErr("ENODATA"); },
      resolve4: async () => ["93.184.216.34"],
    });
    expect(r).toEqual({ ok: true, code: "ok" });
  });

  it("no_mail when neither MX nor A resolves", async () => {
    const r = await checkEmail("bob@nodomain-xyz123.com", {
      resolveMx: async () => { throw dnsErr("ENOTFOUND"); },
      resolve4: async () => { throw dnsErr("ENOTFOUND"); },
    });
    expect(r).toEqual({ ok: false, code: "no_mail", message: "That email address can't receive mail. Mind checking it?" });
  });

  it("no_mail on a null MX (RFC 7505)", async () => {
    const r = await checkEmail("bob@example.com", {
      resolveMx: async () => [{ exchange: "", priority: 0 }],
      resolve4: async () => ["93.184.216.34"],
    });
    expect(r.code).toBe("no_mail");
  });

  it("passes when DNS fails for a reason other than 'does not exist'", async () => {
    const r = await checkEmail("bob@example.com", {
      resolveMx: async () => { throw dnsErr("ESERVFAIL"); },
      resolve4: async () => { throw dnsErr("ETIMEOUT"); },
    });
    expect(r.ok).toBe(true);
  });

  it("disposable", async () => {
    const r = await checkEmail("bob@mailinator.com", mailOk);
    expect(r).toEqual({ ok: false, code: "disposable", message: "Please use an email you check, so your fixes reach you." });
  });

  it("typo suggestions (ok:true, never a block)", async () => {
    const cases: [string, string][] = [
      ["bob@gmial.com", "bob@gmail.com"],
      ["bob@gmal.com", "bob@gmail.com"],
      ["bob@gmai.com", "bob@gmail.com"],
      ["bob@gnail.com", "bob@gmail.com"],
      ["bob@hotmial.com", "bob@hotmail.com"],
      ["bob@hotmal.com", "bob@hotmail.com"],
      ["bob@yaho.com", "bob@yahoo.com"],
      ["bob@yahooo.com", "bob@yahoo.com"],
      ["bob@iclod.com", "bob@icloud.com"],
      ["bob@icoud.com", "bob@icloud.com"],
      ["bob@outlok.com", "bob@outlook.com"],
      ["bob@gmail.con", "bob@gmail.com"],
      ["bob@janedoe.cmo", "bob@janedoe.com"],
      ["bob@janedoe.comm", "bob@janedoe.com"],
      ["bob@gmial.con", "bob@gmail.com"],
    ];
    for (const [input, suggestion] of cases) {
      const r = await checkEmail(input, mailOk);
      expect(r, input).toEqual({ ok: true, code: "typo", suggestion, message: `Did you mean ${suggestion}?` });
    }
  });

  it("no typo for real domains", async () => {
    expect((await checkEmail("bob@gmail.com", mailOk)).code).toBe("ok");
    expect((await checkEmail("bob@company.co", mailOk)).code).toBe("ok");
  });
});

// --- website ---------------------------------------------------------------

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function html(body: string, title = "Jane Doe Photography"): string {
  return `<!doctype html><html><head><title>${title}</title><script>var x = "coming soon";</script></head><body>${body}</body></html>`;
}

function fetchReturning(...responses: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

describe("checkWebsite", () => {
  const notLoading = { ok: false, code: "not_loading", message: "We couldn't open that website. Mind checking the address?" };

  it("bad_url for junk and private hosts, without DNS or fetch", async () => {
    const lookup = vi.fn(publicLookup);
    const { impl, calls } = fetchReturning();
    for (const s of ["", "not a url", "localhost", "http://127.0.0.1", "http://192.168.1.10/", "ftp://example.com", "intranet"]) {
      const r = await checkWebsite(s, { lookup, fetchImpl: impl });
      expect(r, s).toEqual({ ok: false, code: "bad_url", message: "We couldn't open that website. Mind checking the address?" });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("no_such_site when the host does not resolve", async () => {
    const { impl, calls } = fetchReturning();
    const r = await checkWebsite("example.invalid", { lookup: async () => { throw dnsErr("ENOTFOUND"); }, fetchImpl: impl });
    expect(r).toEqual({ ok: false, code: "no_such_site", message: "We couldn't open that website. Mind checking the address?" });
    expect(calls).toHaveLength(0);
  });

  it("bad_url when the host resolves to a private or reserved address", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "100.64.1.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:a00:1", "64:ff9b::a00:1"]) {
      const { impl, calls } = fetchReturning();
      const r = await checkWebsite("sneaky.example.com", {
        lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        fetchImpl: impl,
      });
      expect(r.code, address).toBe("bad_url");
      expect(calls).toHaveLength(0);
    }
  });

  it("ok for a live homepage; adds https:// and sends a browser UA without cookies", async () => {
    const { impl, calls } = fetchReturning(new Response(html("<h1>Wedding photos in Austin</h1>"), { status: 200 }));
    const r = await checkWebsite("gabbyjphotography.com", { lookup: publicLookup, fetchImpl: impl });
    expect(r).toEqual({ ok: true, code: "ok", url: "https://gabbyjphotography.com/" });
    expect(calls[0].url).toBe("https://gabbyjphotography.com/");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("user-agent")).toMatch(/Mozilla\/5\.0.*Chrome/);
    expect(headers.get("cookie")).toBeNull();
    expect(calls[0].init?.redirect).toBe("manual");
    expect(calls[0].init?.credentials).toBe("omit");
  });

  it("follows redirects, re-checking each target, and reports the final url", async () => {
    const lookup = vi.fn(publicLookup);
    const { impl, calls } = fetchReturning(
      new Response(null, { status: 301, headers: { location: "https://www.janedoe.com/" } }),
      new Response(null, { status: 302, headers: { location: "/home" } }),
      new Response(html("<p>Hi</p>"), { status: 200 }),
    );
    const r = await checkWebsite("http://janedoe.com", { lookup, fetchImpl: impl });
    expect(r).toEqual({ ok: true, code: "ok", url: "https://www.janedoe.com/home" });
    expect(calls.map((c) => c.url)).toEqual(["http://janedoe.com/", "https://www.janedoe.com/", "https://www.janedoe.com/home"]);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("refuses a redirect to a private host", async () => {
    const { impl, calls } = fetchReturning(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    const r = await checkWebsite("janedoe.com", { lookup: publicLookup, fetchImpl: impl });
    expect(r.code).toBe("bad_url");
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect whose host resolves privately", async () => {
    const lookup = vi.fn(async (h: string) =>
      h === "evil.example.net" ? [{ address: "10.1.2.3", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);
    const { impl, calls } = fetchReturning(new Response(null, { status: 302, headers: { location: "https://evil.example.net/" } }));
    const r = await checkWebsite("janedoe.com", { lookup, fetchImpl: impl });
    expect(r.code).toBe("bad_url");
    expect(calls).toHaveLength(1);
  });

  it("not_loading after more than 5 redirects", async () => {
    const loops = Array.from({ length: 6 }, (_, i) => new Response(null, { status: 302, headers: { location: `https://janedoe.com/r${i}` } }));
    const { impl, calls } = fetchReturning(...loops);
    const r = await checkWebsite("janedoe.com", { lookup: publicLookup, fetchImpl: impl });
    expect(r).toEqual(notLoading);
    expect(calls).toHaveLength(6);
  });

  it("not_loading on an error status", async () => {
    for (const status of [404, 500, 403]) {
      const { impl } = fetchReturning(new Response("nope", { status }));
      expect(await checkWebsite("janedoe.com", { lookup: publicLookup, fetchImpl: impl }), String(status)).toEqual(notLoading);
    }
  });

  it("not_loading when the fetch fails", async () => {
    const { impl } = fetchReturning(new TypeError("fetch failed"));
    expect(await checkWebsite("janedoe.com", { lookup: publicLookup, fetchImpl: impl })).toEqual(notLoading);
  });

  it("ok on a bot-check page (403/429/503), so Firecrawl decides", async () => {
    const pages: [number, string][] = [
      [403, html("Checking your browser", "Just a moment...")],
      [503, html("Please wait", "Just a moment...")],
      [403, html("Sorry, you have been blocked", "Attention Required! | Cloudflare")],
      [429, html("x", "Just a moment...")],
    ];
    for (const [status, body] of pages) {
      const { impl } = fetchReturning(new Response(body, { status }));
      const r = await checkWebsite("janedoe.com", { lookup: publicLookup, fetchImpl: impl });
      expect(r.code, `${status}`).toBe("ok");
      expect(r.ok).toBe(true);
    }
  });

  it("placeholder pages", async () => {
    const pages = [
      html("<h1>Coming Soon</h1>"),
      html("<p>Site under construction</p>"),
      html("<p>x</p>", "Launching soon!"),
      html("<p>We are in maintenance mode</p>"),
      html("<p>This domain is for sale</p>"),
      html("<p>Buy this domain today</p>"),
      html("<p>Parked free, courtesy of GoDaddy</p>"),
    ];
    for (const body of pages) {
      const { impl } = fetchReturning(new Response(body, { status: 200 }));
      const r = await checkWebsite("janedoe.com", { lookup: publicLookup, fetchImpl: impl });
      expect(r, body).toEqual({
        ok: false,
        code: "placeholder",
        message: "Your site looks like it's still a coming soon page. Come back once your homepage is live and I'll make your fixes.",
      });
    }
  });

  it("ignores placeholder words inside scripts and beyond the first 5,000 text chars", async () => {
    const late = html(`<p>${"word ".repeat(1100)}</p><p>new galleries coming soon</p>`);
    const { impl } = fetchReturning(new Response(late, { status: 200 }));
    expect((await checkWebsite("janedoe.com", { lookup: publicLookup, fetchImpl: impl })).code).toBe("ok");
  });

  it("reads at most 512 KB of the body", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += chunk.length;
        if (pulled > 4 * 1024 * 1024) c.close();
        else c.enqueue(chunk);
      },
    });
    const { impl } = fetchReturning(new Response(stream, { status: 200 }));
    const r = await checkWebsite("janedoe.com", { lookup: publicLookup, fetchImpl: impl });
    expect(r.code).toBe("ok");
    expect(pulled).toBeLessThanOrEqual(512 * 1024 + 2 * chunk.length);
  });
});
