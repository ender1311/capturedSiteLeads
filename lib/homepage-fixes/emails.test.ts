import { describe, expect, it } from "vitest";
import { alertEmail, cantSeeEmail, hobbyEmail, reportEmail, TOUR_URL } from "./emails";

const PDF = "https://blob.example.com/homepage-fixes/1-abc/your-top-homepage-fixes-jane.pdf";
const COMPLIMENT = "Your family sessions on the beach feel warm and full of light.";

const all = () => [
  reportEmail("Jane", PDF, true),
  reportEmail("Jane", PDF, false),
  cantSeeEmail("Jane", "couldnt_load"),
  cantSeeEmail("Jane", "not_live"),
  cantSeeEmail("Jane", "too_little"),
  hobbyEmail("Jane", COMPLIMENT),
];

// Visible copy only: drop the doctype and tags so "<!DOCTYPE" doesn't count as an exclamation point.
const visible = (html: string) => html.replace(/<!DOCTYPE[^>]*>/i, "").replace(/<[^>]+>/g, " ");

describe("homepage-fixes emails", () => {
  it("emails contain no dashes, no exclamation points, spell Captured Sites", () => {
    for (const e of all()) {
      for (const s of [e.subject, e.text, e.html]) {
        expect(s).not.toMatch(/[–—]|&mdash;|&ndash;|&#821[12];/);
      }
      for (const s of [e.subject, e.text, visible(e.html)]) expect(s).not.toContain("!");
      expect(e.text).toContain("Captured Sites");
      expect(e.html).toContain("Captured Sites");
      expect(`${e.text} ${visible(e.html)}`).not.toMatch(/captured ?site(?!s)|capturedsites(?!\.com)|Captured sites|captured Sites/);
    }
  });

  it("report and can't-see emails carry the Tour link; every email has the sign-off", () => {
    expect(TOUR_URL).toBe("https://capturedsites.com/tour/?utm_source=homepage-fixes&utm_medium=email&utm_campaign=homepage-fixes");
    for (const e of all()) expect(e.text).toContain("Talk soon,\nMaggie\nCaptured Sites");
    for (const e of all().slice(0, 5)) {
      expect(e.text).toContain(TOUR_URL);
      expect(e.html).toContain(TOUR_URL.replace(/&/g, "&amp;"));
    }
    const report = "If you'd love to see what it looks like to have your whole website built this way, I'd love to show you around on a Captured Sites Tour.";
    const cantSee = "If you'd ever like help with your website, I'd love to show you around on a Captured Sites Tour.";
    expect(reportEmail("Jane", PDF, true).text).toContain(report);
    for (const r of ["not_live", "too_little", "couldnt_load"] as const) {
      expect(cantSeeEmail("Jane", r).text).toContain(cantSee);
      expect(cantSeeEmail("Jane", r).text).not.toContain("built this way");
    }
  });

  it("hobby email has no Tour line", () => {
    const e = hobbyEmail("Jane", COMPLIMENT);
    expect(e.text).not.toContain(TOUR_URL);
    expect(e.html).not.toContain("capturedsites.com/tour");
    expect(e.text).not.toContain("Tour");
  });

  it("uses inline styles only, no <style> blocks", () => {
    for (const e of [...all(), alertEmail("held", { id: "1", name: "Jane", email: "j@x.com", site_url: "https://x.com" })]) {
      expect(e.html).not.toMatch(/<style/i);
    }
  });

  it("reportEmail has the exact subject, button and body", () => {
    const e = reportEmail("Jane", PDF, true);
    expect(e.subject).toBe("Jane, your homepage fixes are ready");
    expect(e.html).toContain(`href="${PDF}"`);
    expect(e.html).toContain("See My Homepage Fixes");
    expect(e.text).toContain("Hi Jane,");
    expect(e.text).toContain(
      "Your Top Homepage Fixes are ready. It's your own homepage, with your own photo and words, showing a new first section and two more opportunities to turn more visitors into inquiries."
    );
    expect(e.text).toContain(
      "If you'd love to see what it looks like to have your whole website built this way, I'd love to show you around on a Captured Sites Tour."
    );
    expect(e.text).toContain(PDF);
  });

  it("reportEmail mentions attachment only when attached", () => {
    const line = "Your fixes are attached to this email, or you can view them online:";
    expect(reportEmail("Jane", PDF, true).text).toContain(line);
    expect(reportEmail("Jane", PDF, true).html).toContain(line);
    expect(reportEmail("Jane", PDF, false).text).not.toContain("attached");
    expect(reportEmail("Jane", PDF, false).html).not.toContain("attached");
  });

  it("cantSeeEmail: couldnt_load asks for another link, not_live asks them to come back", () => {
    const a = cantSeeEmail("Jane", "couldnt_load");
    expect(a.subject).toBe("Jane, a quick note about your homepage fixes");
    expect(a.text).toContain(
      "Thanks so much for asking for your homepage fixes. My homepage review tool couldn't load your homepage, so I wasn't able to make them this time."
    );
    expect(a.text).toContain("If your site lives at another address, just reply with the link and I'll take care of it.");
    expect(a.text).not.toContain("live yet");

    const b = cantSeeEmail("Jane", "not_live");
    expect(b.subject).toBe("Jane, a quick note about your homepage fixes");
    expect(b.text).toContain(
      "Thanks so much for asking for your homepage fixes. It looks like your homepage isn't quite live yet, so I wasn't able to make them this time."
    );
    expect(b.text).toContain("Once it's live, come back to capturedsites.com/homepage-fixes and I'll make them for you.");
    expect(b.text).not.toContain("another address");

    const c = cantSeeEmail("Jane", "too_little");
    expect(c.subject).toBe("Jane, a quick note about your homepage fixes");
    expect(c.text).toContain(
      "Thanks so much for asking for your homepage fixes. My homepage review tool couldn't find enough on your homepage to make your fixes this time."
    );
    expect(c.text).toContain("If your site lives at another address, just reply with the link and I'll take care of it.");
    expect(c.text).not.toContain("couldn't load");
  });

  it("hobbyEmail carries the compliment and the soft door", () => {
    const e = hobbyEmail("Jane", COMPLIMENT);
    expect(e.subject).toBe("Jane, a little note about your website");
    expect(e.text).toContain(`Hi Jane,\n\n${COMPLIMENT}`);
    expect(e.text).toContain(
      "It sounds like photography is something you love doing for yourself right now, so I won't fill your inbox with fixes. If it ever grows into something you want to take further, I'd love to help."
    );
  });

  it("subjects escape nothing and HTML escapes names", () => {
    expect(reportEmail("D'Andre", PDF, true).subject).toBe("D'Andre, your homepage fixes are ready");
    expect(cantSeeEmail("D'Andre", "not_live").subject).toBe("D'Andre, a quick note about your homepage fixes");
    expect(hobbyEmail("D'Andre", COMPLIMENT).subject).toBe("D'Andre, a little note about your website");
    const evil = "<script>alert(1)</script>";
    for (const e of [reportEmail(evil, PDF, true), cantSeeEmail(evil, "couldnt_load"), hobbyEmail(evil, `${evil} nice`)]) {
      expect(e.html).not.toContain("<script>");
      expect(e.html).toContain("&lt;script&gt;");
    }
  });

  it("subjects never carry line breaks", () => {
    expect(reportEmail("Jane\r\nBcc: x@y.com", PDF, true).subject).not.toMatch(/[\r\n]/);
  });

  it("alertEmail lists the lead and links the dashboard", () => {
    const e = alertEmail("held", { id: "lead-1", name: "Jane", email: "jane@x.com", site_url: "https://janedoe.com", error: "look check failed" });
    expect(e.subject).toBe("[Homepage Fixes] held: Jane (https://janedoe.com)");
    for (const s of [e.text, e.html]) {
      expect(s).toContain("lead-1");
      expect(s).toContain("jane@x.com");
      expect(s).toContain("https://janedoe.com");
      expect(s).toContain("look check failed");
      expect(s).toContain("https://captured-site-leads.vercel.app/dashboard");
    }
    expect(alertEmail("cap", { id: "1", name: "<b>", email: "a@b.c", site_url: "s" }).html).not.toContain("<b>");
  });
});
