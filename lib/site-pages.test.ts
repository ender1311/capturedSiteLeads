import { describe, expect, it } from "vitest";
import { classify, discoverPages, locs, MAX_FETCHES, normalizeSiteUrl, safeFetch, toPages, USER_AGENT } from "./site-pages";

// --- fakes: no network, no DNS ----------------------------------------------

type Route = Response | (() => Response);
function fakeNet(routes: Record<string, Route>, dns: Record<string, string[]> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) return new Response("nope", { status: 404 });
    return typeof r === "function" ? r() : r.clone();
  }) as typeof fetch;
  const lookup = async (h: string) => {
    const a = dns[h] ?? ["93.184.216.34"];
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { calls, deps: { fetchImpl, lookup } };
}
const xml = (body: string) => new Response(body, { status: 200 });
const redirect = (to: string) => new Response(null, { status: 301, headers: { location: to } });
const urlset = (...u: string[]) => `<?xml version="1.0"?><urlset>${u.map((x) => `<url><loc>${x}</loc></url>`).join("")}</urlset>`;
const index = (...u: string[]) => `<sitemapindex>${u.map((x) => `<sitemap><loc>${x}</loc></sitemap>`).join("")}</sitemapindex>`;
const ctx = (deps: ReturnType<typeof fakeNet>["deps"]) => ({ ...deps, fetchesLeft: MAX_FETCHES, deadline: Date.now() + 60_000 });

// --- input ------------------------------------------------------------------

describe("normalizeSiteUrl", () => {
  it.each([
    ["yourwebsite.com", "https://yourwebsite.com/"],
    ["www.x.com", "https://www.x.com/"],
    ["https://x.com/anything?a=1#b", "https://x.com/"],
    ["  http://X.com/blog/  ", "http://x.com/"],
  ])("%s -> %s", (input, origin) => {
    expect(normalizeSiteUrl(input)?.href).toBe(origin);
  });

  it.each([
    "", "ftp://x.com", "javascript:alert(1)", "file:///etc/passwd", "localhost", "http://localhost:3000",
    "intranet", "http://8.8.8.8", "127.0.0.1", "http://[::1]/", "http://0x7f.1/", "2130706433",
    "https://user:pw@x.com", "printer.local", "a b.com", 42, null,
  ])("rejects %s", (input) => {
    expect(normalizeSiteUrl(input)).toBeNull();
  });
});

// --- classification ---------------------------------------------------------

describe("classify", () => {
  it.each([
    ["/", "Home", "/", false],
    ["/about/", "About", "/about/", false],
    ["/Meet-Me", "About", "/about/", false],
    ["/contact-me/", "Contact", "/contact/", false],
    ["/book-now/", "Contact", "/contact/", false],
    ["/kind-words/", "Testimonials", "/testimonials/", false],
    ["/privacy-policy/", "Legal", "/privacy-policy/", false],
    ["/terms", "Legal", "/terms", false],
    ["/blog/our-day-at-the-lake/", "Blog post", "/blog/our-day-at-the-lake/", false],
    ["/journal/fall-minis", "Blog post", "/blog/fall-minis/", false],
    ["/2021/05/smith-wedding/", "Blog post", "/blog/smith-wedding/", false],
    ["/blog/", "Blog archive", "/blog/", false],
    ["/category/weddings/", "Blog archive", "/blog/", false],
    ["/blog/tag/family/", "Blog archive", "/blog/", false],
    ["/author/maggie/", "Blog archive", "/blog/", false],
    ["/blog/page/2/", "Blog archive", "/blog/", false],
    ["/weddings/", "Portfolio", "/weddings/", true],
    ["/investment/", "Portfolio", "/investment/", true],
    ["/portfolio/newborn/", "Portfolio", "/portfolio/newborn/", true],
    ["/second-shooter/", "Other", "/second-shooter/", true],
    ["/files/price-guide.pdf", "Other", "/files/price-guide.pdf", true],
  ])("%s -> %s %s", (path, type, target, decide) => {
    expect(classify(path)).toEqual({ path, type, target, decide });
  });

  it("first match wins: About beats Blog, Legal beats Portfolio", () => {
    expect(classify("/blog/about/").type).toBe("About");
    expect(classify("/wedding/terms/").type).toBe("Legal");
  });

  it("pages from a post sitemap are blog posts", () => {
    expect(classify("/smith-wedding/", true)).toEqual({ path: "/smith-wedding/", type: "Blog post", target: "/blog/smith-wedding/", decide: false });
  });
});

// --- SSRF guard -------------------------------------------------------------

describe("safeFetch", () => {
  it.each([
    ["private 10/8", "10.0.0.5"],
    ["private 192.168", "192.168.1.1"],
    ["loopback", "127.0.0.1"],
    ["metadata", "169.254.169.254"],
    ["CGNAT", "100.64.1.2"],
    ["multicast", "224.0.0.1"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped IPv6 loopback", "::ffff:127.0.0.1"],
  ])("refuses a host that resolves to %s, without fetching", async (_, addr) => {
    const net = fakeNet({ "https://evil.com/": xml("secret") }, { "evil.com": [addr] });
    expect(await safeFetch(new URL("https://evil.com/"), ctx(net.deps))).toBeNull();
    expect(net.calls).toHaveLength(0);
  });

  it("refuses when any one of several addresses is private", async () => {
    const net = fakeNet({}, { "x.com": ["93.184.216.34", "10.0.0.1"] });
    expect(await safeFetch(new URL("https://x.com/"), ctx(net.deps))).toBeNull();
    expect(net.calls).toHaveLength(0);
  });

  it("fails closed when DNS errors", async () => {
    const net = fakeNet({ "https://x.com/": xml("hi") });
    const c = { ...ctx(net.deps), lookup: async () => { throw Object.assign(new Error("x"), { code: "ETIMEOUT" }); } };
    expect(await safeFetch(new URL("https://x.com/"), c)).toBeNull();
    expect(net.calls).toHaveLength(0);
  });

  it("refuses a redirect to a private address, and to an IP literal", async () => {
    for (const to of ["http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://inside.corp/"]) {
      const net = fakeNet({ "https://x.com/": redirect(to), [to]: xml("secret") }, { "inside.corp": ["10.1.1.1"] });
      expect(await safeFetch(new URL("https://x.com/"), ctx(net.deps))).toBeNull();
      expect(net.calls.map((c) => c.url)).toEqual(["https://x.com/"]);
    }
  });

  it("follows up to 3 public redirects, by hand, with GET and our user agent", async () => {
    const net = fakeNet({
      "https://x.com/": redirect("https://www.x.com/"),
      "https://www.x.com/": redirect("/a"),
      "https://www.x.com/a": redirect("/b"),
      "https://www.x.com/b": xml("done"),
    });
    expect(await safeFetch(new URL("https://x.com/"), ctx(net.deps))).toBe("done");
    expect(net.calls).toHaveLength(4);
    for (const c of net.calls) {
      expect(c.init).toMatchObject({ method: "GET", redirect: "manual" });
      expect((c.init?.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
    }
  });

  it("gives up after the 4th redirect", async () => {
    const net = fakeNet({
      "https://x.com/": redirect("/1"), "https://x.com/1": redirect("/2"), "https://x.com/2": redirect("/3"),
      "https://x.com/3": redirect("/4"), "https://x.com/4": xml("too far"),
    });
    expect(await safeFetch(new URL("https://x.com/"), ctx(net.deps))).toBeNull();
    expect(net.calls).toHaveLength(4);
  });

  it("caps the body at 2 MB", async () => {
    const big = "a".repeat(3 * 1024 * 1024);
    const net = fakeNet({ "https://x.com/": xml(big) });
    expect((await safeFetch(new URL("https://x.com/"), ctx(net.deps)))?.length).toBe(2 * 1024 * 1024);
  });

  it("stops at the fetch budget", async () => {
    const net = fakeNet({ "https://x.com/": xml("ok") });
    const c = { ...ctx(net.deps), fetchesLeft: 1 };
    expect(await safeFetch(new URL("https://x.com/"), c)).toBe("ok");
    expect(await safeFetch(new URL("https://x.com/"), c)).toBeNull();
    expect(net.calls).toHaveLength(1);
  });
});

// --- discovery --------------------------------------------------------------

describe("discoverPages", () => {
  it("follows nested sitemap indexes, marks post-sitemap pages, keeps same-host pages only", async () => {
    const net = fakeNet({
      "https://x.com/sitemap.xml": xml(index("https://x.com/sitemaps/index-2.xml", "https://x.com/page-sitemap.xml", "https://other.com/post-sitemap.xml")),
      "https://x.com/sitemaps/index-2.xml": xml(index("https://www.x.com/post-sitemap.xml")),
      "https://www.x.com/post-sitemap.xml": xml(urlset("https://www.x.com/smith-wedding/", "https://x.com/hello-world")),
      "https://x.com/page-sitemap.xml": xml(urlset(
        "https://x.com/", "https://x.com/about/", "https://x.com/about/", "https://x.com/weddings/?utm=1",
        "https://other.com/elsewhere/", "https://x.com/wp-content/uploads/a.jpg", "https://x.com/guide.pdf",
        "<![CDATA[https://x.com/contact/]]>",
      )),
    });
    const r = await discoverPages(new URL("https://x.com/"), net.deps);
    expect(r).toEqual({
      host: "x.com",
      source: "sitemap",
      truncated: false,
      pages: [
        { path: "/", type: "Home", target: "/", decide: false },
        { path: "/about/", type: "About", target: "/about/", decide: false },
        { path: "/contact/", type: "Contact", target: "/contact/", decide: false },
        { path: "/guide.pdf", type: "Other", target: "/guide.pdf", decide: true },
        { path: "/hello-world", type: "Blog post", target: "/blog/hello-world/", decide: false },
        { path: "/smith-wedding/", type: "Blog post", target: "/blog/smith-wedding/", decide: false },
        { path: "/weddings/", type: "Portfolio", target: "/weddings/", decide: true },
      ],
    });
    expect(net.calls.some((c) => c.url.includes("other.com"))).toBe(false);
  });

  it("survives a sitemap index that lists itself", async () => {
    const net = fakeNet({ "https://x.com/sitemap.xml": xml(index("https://x.com/sitemap.xml", "https://x.com/s2.xml")), "https://x.com/s2.xml": xml(urlset("https://x.com/a/")) });
    expect((await discoverPages(new URL("https://x.com/"), net.deps))?.pages.map((p) => p.path)).toEqual(["/a/"]);
  });

  it("falls back to sitemap_index.xml, then robots.txt Sitemap lines", async () => {
    const a = fakeNet({ "https://x.com/sitemap_index.xml": xml(urlset("https://x.com/a/")) });
    expect((await discoverPages(new URL("https://x.com/"), a.deps))?.pages.map((p) => p.path)).toEqual(["/a/"]);
    const b = fakeNet({
      "https://x.com/robots.txt": xml("User-agent: *\nSitemap: https://x.com/custom.xml\n"),
      "https://x.com/custom.xml": xml(urlset("https://x.com/b/")),
    });
    expect((await discoverPages(new URL("https://x.com/"), b.deps))?.pages.map((p) => p.path)).toEqual(["/b/"]);
  });

  it("falls back to homepage links (depth 1)", async () => {
    const net = fakeNet({
      "https://x.com/": xml(`<a href="/about">A</a><a href='https://www.x.com/gallery/'>G</a><a href="https://ig.com/x">I</a><a href="mailto:a@b.c">M</a><a href="#top">T</a><img src="/a.png">`),
    });
    const r = await discoverPages(new URL("https://x.com/"), net.deps);
    expect(r?.source).toBe("links");
    expect(r?.pages.map((p) => p.path)).toEqual(["/", "/about", "/gallery/"]);
  });

  it("null when nothing is found", async () => {
    expect(await discoverPages(new URL("https://x.com/"), fakeNet({}).deps)).toBeNull();
  });

  it("never makes more than 25 fetches", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `https://x.com/s${i}.xml`);
    const routes: Record<string, Route> = { "https://x.com/sitemap.xml": xml(index(...many)) };
    for (const u of many) routes[u] = xml(urlset(`${u.replace(".xml", "/")}`));
    const net = fakeNet(routes);
    const r = await discoverPages(new URL("https://x.com/"), net.deps);
    expect(net.calls).toHaveLength(MAX_FETCHES);
    expect(r?.pages).toHaveLength(MAX_FETCHES - 1);
  });
});

describe("toPages", () => {
  it("caps at 500 and sorts / first then alphabetically", () => {
    const found = new Map<string, boolean>(Array.from({ length: 600 }, (_, i) => [`/p${String(i).padStart(3, "0")}/`, false]));
    found.set("/", false);
    const { pages, truncated } = toPages(found);
    expect(truncated).toBe(true);
    expect(pages).toHaveLength(500);
    expect(pages[0].path).toBe("/");
    expect(pages[1].path).toBe("/p000/");
    expect(toPages(new Map([["/b", false], ["/", false], ["/a", false]])).pages.map((p) => p.path)).toEqual(["/", "/a", "/b"]);
    expect(toPages(new Map([["/a", false]])).truncated).toBe(false);
  });

  it("locs decodes entities", () => {
    expect(locs("<loc> https://x.com/a?b=1&amp;c=2 </loc>")).toEqual(["https://x.com/a?b=1&c=2"]);
  });
});
