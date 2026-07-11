import { HEADSHOT_PNG, MOCKUPS_PNG, LOGO_PNG } from "./template-assets";

export type Opportunity = {
  headline: string;
  noticed: string;
  whyItMatters: string;
  fixFraming: string;
  fixes: string[];
};

export type ReportCopy = {
  opportunities: Opportunity[];
};

const esc = (s: string) =>
  s
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // strip markdown emphasis the LLM sneaks in
    .replace(/`/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const spark = (size: number, color: string, opacity: number) => `
  <svg width="${size}" height="${size}" viewBox="0 0 24 24" style="opacity:${opacity}">
    <path fill="${color}" d="M12 0c.6 6.5 5.5 11.4 12 12-6.5.6-11.4 5.5-12 12-.6-6.5-5.5-11.4-12-12C6.5 11.4 11.4 6.5 12 0z"/>
  </svg>`;

const bullet = `
  <svg width="22" height="22" viewBox="0 0 24 24" style="flex:none;margin-top:1px">
    <path fill="#dba927" d="M12 1l1.8 7.6 7.2 1.4-6.2 3.4 1.4 7.6-4.2-5-6.6 3.6 3.6-6.6-5-4.2 7.6 1.4L12 1z"/>
  </svg>`;

const QUESTIONS = [
  ["What can you do for me?", "Within seconds: am I in the right place? Do you serve people like me? What's the next step? This is your hero section."],
  ["Why should I trust you?", "They want to connect with you, framed around their desires and pain points, not just facts about you. This is your guide section."],
  ["What is it like to work with you?", "A clear snapshot of your services with an easy path to learn more — words and photos working together. This is your portfolio section."],
  ["Have you done this before?", "Social proof that you've delivered. Even if they don't read every word, testimonials build enormous trust. This is your testimonial section."],
  ["How do I get started?", "Make the next step unmissable, and use it to showcase what makes working with you special. This is your steps section."],
];

export function renderReportHtml(input: {
  name: string;
  siteUrl: string;
  copy: ReportCopy;
  ctaUrl: string;
}): string {
  const domain = input.siteUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const oppPages = input.copy.opportunities
    .slice(0, 3)
    .map(
      (o, i) => `
  <div class="page white">
    <div class="opp-head">
      <div class="opp-num">${i + 1}</div>
      <div class="opp-label">OPPORTUNITY #${i + 1}</div>
      <div class="watermark">0${i + 1}</div>
    </div>
    <h2 class="opp-headline">${esc(o.headline)}</h2>
    <div class="card cream">
      <div class="card-label olive">WHAT I NOTICED</div>
      <p>${esc(o.noticed)}</p>
    </div>
    <div class="card dark">
      <div class="card-label olive">WHY IT MATTERS</div>
      <p>${esc(o.whyItMatters)}</p>
    </div>
    <div class="card outlined">
      <div class="card-label olive">HOW TO MAKE IT RIGHT</div>
      <p class="fix-framing">${esc(o.fixFraming)}</p>
      ${o.fixes.map((f) => `<div class="fix">${bullet}<p>${esc(f)}</p></div>`).join("")}
    </div>
  </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,400;0,700;0,900;1,400;1,700&family=Lora:ital,wght@1,500;1,600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { font-family: 'Lato', sans-serif; }
  .page { width: 816px; height: 1056px; position: relative; overflow: hidden; page-break-after: always; }
  .page.white { background: #fff; padding: 64px 72px; }
  .page.dark-bg { background: #143133; }

  /* ---------- cover ---------- */
  .cover { background: linear-gradient(140deg, #2e6e73 0%, #3d7b7f 45%, #4b878b 100%); text-align: center; }
  .cover .sparks-tr { position: absolute; top: 40px; right: 36px; }
  .cover .sparks-ml { position: absolute; top: 470px; left: 40px; }
  .cover .badge { display: inline-block; margin-top: 240px; background: #a0a93f; color: #143133; font-weight: 700; font-size: 17px; letter-spacing: .05em; padding: 9px 22px; }
  .cover h1 { color: #fff; font-weight: 900; font-size: 76px; line-height: 1.12; margin-top: 26px; }
  .cover .bar { width: 64px; height: 12px; background: #dba927; margin: 34px auto 0; }
  .cover .prepared { font-family: 'Lora', serif; font-style: italic; color: #fff; font-size: 23px; margin-top: 30px; }
  .cover .lead-name { color: #fff; font-weight: 900; font-size: 46px; margin-top: 12px; }
  .cover .lead-site { color: #e6efef; font-size: 24px; margin-top: 12px; text-decoration: underline; }
  .cover .cover-byline { color: #cfe0e0; font-size: 13px; margin-top: 26px; }
  .wave { position: absolute; bottom: 0; left: 0; width: 100%; }
  .cover .logo, .final .logo { position: absolute; right: 44px; bottom: 34px; width: 190px; }

  /* ---------- intro (what we do) ---------- */
  .label { color: #a0a93f; font-weight: 700; font-size: 15px; letter-spacing: .28em; }
  .intro h2 { color: #337a80; font-weight: 900; font-size: 44px; line-height: 1.18; margin: 18px 0 24px; }
  .intro .body { color: #111; font-size: 15.5px; line-height: 1.62; }
  .qrow { display: flex; gap: 20px; margin-top: 26px; align-items: flex-start; }
  .qnum { flex: none; width: 44px; height: 44px; border-radius: 50%; border: 2.5px solid #dba927; color: #337a80; font-weight: 900; font-size: 19px; display: flex; align-items: center; justify-content: center; }
  .qrow h3 { color: #337a80; font-size: 17px; font-weight: 900; }
  .qrow p { color: #333; font-size: 13.5px; line-height: 1.5; margin-top: 4px; }
  .intro .kicker { font-style: italic; font-weight: 700; color: #143133; font-size: 16.5px; margin-top: 34px; line-height: 1.5; }

  /* ---------- opportunity pages ---------- */
  .opp-head { display: flex; align-items: center; gap: 16px; position: relative; }
  .opp-num { width: 46px; height: 46px; border-radius: 50%; background: #337a80; color: #fff; font-weight: 900; font-size: 20px; display: flex; align-items: center; justify-content: center; }
  .opp-label { color: #337a80; font-weight: 700; font-size: 16px; letter-spacing: .28em; }
  .watermark { position: absolute; top: -34px; right: -14px; font-weight: 900; font-size: 190px; color: #f0f0ee; line-height: 1; z-index: 0; }
  .opp-headline { color: #1a4245; font-weight: 900; font-size: 34px; line-height: 1.22; margin: 28px 0 30px; position: relative; z-index: 1; max-width: 600px; }
  .card { border-radius: 16px; padding: 26px 30px; margin-bottom: 26px; position: relative; z-index: 1; }
  .card.cream { background: #f6f6ec; }
  .card.dark { background: #1a4245; }
  .card.outlined { background: #fff; border: 2px solid #dba927; }
  .card-label { font-weight: 700; font-size: 13.5px; letter-spacing: .22em; margin-bottom: 12px; }
  .olive { color: #a0a93f; }
  .card p { color: #111; font-size: 14.5px; line-height: 1.58; }
  .card.dark p { color: #f2f6f5; }
  .fix { display: flex; gap: 14px; margin-top: 13px; }
  .fix p { margin: 0; }
  .fix-framing { font-weight: 700; }

  /* ---------- next / final ---------- */
  .next { padding: 72px 76px; }
  .next h2 { color: #fff; font-weight: 900; font-size: 40px; line-height: 1.22; margin: 18px 0 26px; }
  .next .body { color: #e4ecec; font-size: 15.5px; line-height: 1.66; margin-bottom: 22px; }
  .next .quote { font-family: 'Lora', serif; font-style: italic; color: #dba927; font-size: 24px; line-height: 1.45; margin: 30px 0; }
  .btn { display: block; width: 220px; margin: 44px auto 0; background: #a0a93f; color: #143133; font-weight: 900; font-size: 19px; text-align: center; text-decoration: none; padding: 16px 0; border-radius: 999px; }
  .final { text-align: center; padding: 70px 80px; }
  .final .headshot { width: 172px; height: 172px; border-radius: 50%; object-fit: cover; margin-top: 10px; }
  .final .quote { color: #fff; font-weight: 900; font-size: 33px; line-height: 1.3; margin: 34px auto 0; max-width: 560px; }
  .final .attr { color: #c6d4d3; font-size: 15px; margin-top: 22px; }
  .final .mockups { width: 640px; margin-top: 48px; }
</style>
</head>
<body>

  <div class="page cover">
    <div class="sparks-tr">${spark(120, "#3d7b7f", 0.9)}${spark(64, "#a0a93f", 0.55)}</div>
    <div class="sparks-ml">${spark(88, "#a0a93f", 0.5)}</div>
    <div><span class="badge">Personalized Website Analysis</span></div>
    <h1>Dream Client<br>Roadmap</h1>
    <div class="bar"></div>
    <div class="prepared">prepared exclusively for</div>
    <div class="lead-name">${esc(input.name)}</div>
    <div class="lead-site">${esc(domain)}</div>
    <div class="cover-byline">From Maggie &middot; Captured Sites &middot; ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
    <svg class="wave" viewBox="0 0 816 260" preserveAspectRatio="none" height="260"><path fill="#143133" d="M0,140 C170,40 320,220 520,150 C660,100 750,60 816,90 L816,260 L0,260 Z"/></svg>
    <img class="logo" src="${LOGO_PNG}" alt="captured">
  </div>

  <div class="page white intro">
    <div class="label">THE FOUNDATION</div>
    <h2>What every visitor is asking when they land on your site</h2>
    <p class="body">Before I show you what I found on your site, here's the framework I use. When a photographer's website answers these five questions clearly and in order, visitors move naturally toward the contact form. When it doesn't, they drop off before ever reaching out.</p>
    ${QUESTIONS.map(
      ([q, a], i) => `
    <div class="qrow">
      <div class="qnum">${i + 1}</div>
      <div><h3>${q}</h3><p>${a}</p></div>
    </div>`
    ).join("")}
    <p class="kicker">When these questions are answered clearly and in order, visitors move naturally toward your contact form. Here's what I found on your site.</p>
  </div>

  ${oppPages}

  <div class="page dark-bg next">
    <div class="label">WHAT HAPPENS NEXT</div>
    <h2>Your site is closer than you think to converting visitors into bookings.</h2>
    <p class="body">You can absolutely take what I shared and work on it yourself, and those changes will help. It's kind of like editing a RAW photo. You can push it pretty far in post by tweaking, but at some point you realize the foundation — like lighting and settings — had to be right from the start. Your website works the same way. The biggest shift happens when the whole site is built from the ground up with the right strategy.</p>
    <p class="quote">We really approach your website like a client-generating machine, because that's exactly how you're going to get more of the bookings you want.</p>
    <p class="body">And this is what we do all day, every day, exclusively for photographers. Done-for-you websites with SEO built in, and I love doing it. If you want to explore what it would look like to have it completely handled for you, I'd love to show you.</p>
    <a class="btn" href="${esc(input.ctaUrl)}">Book Your Free Tour</a>
    <p class="body" style="text-align:center;margin-top:26px;color:#9db6b5">Maggie &middot; Captured Sites</p>
  </div>

  <div class="page dark-bg final">
    <img class="headshot" src="${HEADSHOT_PNG}" alt="">
    <div class="quote">&ldquo;Since launching I booked my highest package ever and now book 1-2 weddings a month consistently!&rdquo;</div>
    <div class="attr">Paige Crumly Photography</div>
    <img class="mockups" src="${MOCKUPS_PNG}" alt="">
    <a class="btn" href="${esc(input.ctaUrl)}">Book Your Free Tour</a>
    <img class="logo" src="${LOGO_PNG}" alt="captured">
  </div>

</body>
</html>`;
}
