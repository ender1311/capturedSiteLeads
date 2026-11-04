// In-page scripts for Firecrawl `executeJavascript` actions.
// Ported from the skill's scripts/capture.mjs (dismiss() and the page.evaluate body).
// They run inside the scraped page, so they are plain ES2017 strings with no imports
// (no optional chaining, no nullish coalescing, no object spread).
//
// Firecrawl's action browser has a 1920x100000 viewport, so the page is re-loaded in a
// same-origin 1440x900 iframe (FRAME_SCRIPT) and the other scripts work inside it.
// When framing is blocked or the frame is empty they fall back to the top window.

export const FRAME_ID = "__hf";
export const SCREEN_W = 1440;
export const SCREEN_H = 900;

// Resolves W (window) and D (document): the iframe when it is readable and has text,
// else the top window. SH is the height of one screen in that window.
const RESOLVE = `
  var W = window, D = document, frame = false;
  try {
    var fr = document.getElementById('${FRAME_ID}');
    var fd = fr && fr.contentDocument;
    if (fd && fd.body && (fd.body.innerText || '').trim().length > 50) { W = fr.contentWindow; D = fd; frame = true; }
  } catch (e) {}
  // The screenshot window has no scrollbar; hide the frame's so its layout is a full 1440px
  // (a 15px scrollbar can tip builders like Squarespace into their burger menu).
  if (frame && !D.getElementById('__hf_style')) {
    try {
      var hs0 = D.createElement('style'); hs0.id = '__hf_style';
      hs0.textContent = 'html{scrollbar-width:none}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none;width:0;height:0}';
      (D.head || D.documentElement).appendChild(hs0);
      W.dispatchEvent(new W.Event('resize'));
    } catch (e) {}
  }
  // The top window reports a 100000px-tall viewport; fall back to its outer height for one screen.
  var SH = frame ? W.innerHeight : (W.innerHeight > 1500 ? (W.outerHeight > 0 && W.outerHeight <= 1500 ? W.outerHeight : 1080) : W.innerHeight);
`;

// Adds the hidden 1440x900 iframe of the same page. Returns a status string.
export const FRAME_SCRIPT = `(function () {
  if (document.getElementById('${FRAME_ID}')) return 'frame exists';
  var f = document.createElement('iframe');
  f.id = '${FRAME_ID}';
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  f.setAttribute('style', 'position:fixed;left:0;top:0;width:${SCREEN_W}px;height:${SCREEN_H}px;border:0;z-index:2147483647;opacity:0;pointer-events:none');
  f.src = location.href;
  document.body.appendChild(f);
  return 'frame added';
})()`;

// Scrolls the resolved window to a fraction of its height so lazy images load.
// Also switches native lazy images to eager. Returns a status string.
export function scrollStepScript(fraction: number): string {
  return `(function () {${RESOLVE}
  try { Array.prototype.slice.call(D.querySelectorAll('img[loading="lazy"]')).forEach(function (im) { im.loading = 'eager'; }); } catch (e) {}
  W.scrollTo(0, Math.round(D.documentElement.scrollHeight * ${fraction}));
  return 'scrolled ${fraction}';
})()`;
}

// capture.mjs dismiss(): click consent/close buttons, press Escape, then remove large
// fixed overlays that still cover the page. Returns the removed popups' texts.
export const DISMISS_SCRIPT = `(function () {${RESOLVE}
  var out = [];
  var visible = function (el) {
    var r = el.getBoundingClientRect(); var s = W.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0;
  };
  var names = ['Accept all', 'Accept All', 'Accept', 'I agree', 'Got it', 'OK', 'No thanks', 'No, thanks', 'Close', 'Dismiss'];
  var buttons = Array.prototype.slice.call(D.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
  names.forEach(function (t) {
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var label = (b.getAttribute('aria-label') || b.innerText || b.value || '').replace(/\\s+/g, ' ').trim();
      if (label !== t) continue;
      try { if (b.isConnected && visible(b)) { b.click(); } } catch (e) {}
      break;
    }
  });
  ['[aria-label="Close"]', '[aria-label="close"]', '.pum-close', '.mfp-close', '.modal .close', 'button.close'].forEach(function (sel) {
    try { var el = D.querySelector(sel); if (el && visible(el)) el.click(); } catch (e) {}
  });
  try {
    var esc = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
    (D.activeElement || D.body).dispatchEvent(new W.KeyboardEvent('keydown', esc));
    D.dispatchEvent(new W.KeyboardEvent('keydown', esc));
  } catch (e) {}
  // Large fixed overlays (popups) that still cover the page. Headers are small, so they stay.
  var all = Array.prototype.slice.call(D.querySelectorAll('body *'));
  for (var j = 0; j < all.length; j++) {
    var el = all[j];
    if (!el.isConnected || el.id === '${FRAME_ID}') continue;
    var s = W.getComputedStyle(el);
    if (s.position !== 'fixed') continue;
    var r = el.getBoundingClientRect();
    var text = (el.innerText || '').trim();
    // Only real popups: they have words or are dialogs. Empty fixed layers can be the hero photo.
    var popup = text.length > 0 || el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';
    if (popup && +s.zIndex >= 10 && Math.min(r.height, SH) * r.width > W.innerWidth * SH * 0.3) { out.push(text.slice(0, 80)); el.remove(); }
  }
  D.documentElement.style.overflow = 'auto'; D.body.style.overflow = 'auto';
  return out;
})()`;

// capture.mjs page.evaluate body, plus navTop, navOverPhoto, navBg, navColor,
// uppercaseHeadings, accent, frame and screenH. Removes the iframe at the end so the
// screenshot stays clean. Returns JSON.stringify(PageData without `dismissed`).
export const EXTRACT_SCRIPT = `(function () {${RESOLVE}
  W.scrollTo(0, 0); window.scrollTo(0, 0);
  // Opacity 0 still counts as visible for an un-triggered fade-in: a fade token class or
  // data-aos/data-animation on the element or its parent, or (in main content only) a
  // transition/animation on the element itself. Never inside hidden menus, dialogs or popups.
  var fadeTok = /(^|[\s_-])(fade|fade-in|fadeIn|animate|animated|reveal|aos-init|aos-animate|preFade|in-view|wow)([\s_-]|$)/i;
  var hideRe = /menu|drawer|overlay|modal|popup|lightbox|offcanvas|mobile-nav|burger/i;
  var cls = function (e) { var c = e.className; return String(c && c.baseVal !== undefined ? c.baseVal : c || ''); };
  var inHiddenUi = function (el) {
    // Stop below body: builders put theme tokens on body (Squarespace: "header-overlay-…").
    for (var e = el; e && e.nodeType === 1 && e !== D.body && e !== D.documentElement; e = e.parentElement) {
      if (e.matches('[aria-hidden="true"],[role="dialog"],[aria-modal="true"],dialog')) return true;
      if (hideRe.test(cls(e) + ' ' + (e.id || ''))) return true;
    }
    return false;
  };
  var fadeIn = function (el) {
    if (inHiddenUi(el)) return false;
    for (var e = el, k = 0; e && e.nodeType === 1 && k < 2; e = e.parentElement, k++) {
      if (fadeTok.test(cls(e)) || e.hasAttribute('data-aos') || e.hasAttribute('data-animation')) return true;
    }
    if (el.closest('header,nav,footer,[role="banner"],[role="navigation"],[role="contentinfo"]')) return false;
    var cs = W.getComputedStyle(el);
    return /[1-9]/.test(cs.transitionDuration || '') || (!!cs.animationName && cs.animationName !== 'none');
  };
  var vis = function (el) { var r = el.getBoundingClientRect(); var s = W.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && (+s.opacity !== 0 || fadeIn(el)); };
  var arr = function (list) { return Array.prototype.slice.call(list); };
  var transparent = function (c) {
    if (!c || c === 'transparent') return true;
    var m = c.match(/rgba?\\(([^)]*)\\)/);
    if (!m) return false;
    var parts = m[1].split(/[\\s,\\/]+/).filter(Boolean);
    return parts.length >= 4 && parseFloat(parts[3]) === 0;
  };
  var sy = W.scrollY;
  var rows = [];
  D.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,button,li,span,div,em,strong,b,label,blockquote,figcaption').forEach(function (el) {
    if (!vis(el)) return;
    var own = arr(el.childNodes).filter(function (x) { return x.nodeType === 3; }).map(function (x) { return x.textContent.trim(); }).join(' ').replace(/\\s+/g, ' ').trim();
    if (!own || own.length < 2) return;
    var r = el.getBoundingClientRect(); var s = W.getComputedStyle(el); var a = el.closest('a');
    var row = { tag: el.tagName.toLowerCase(), y: Math.round(r.top + sy), x: Math.round(r.left), fs: parseFloat(s.fontSize), fw: s.fontWeight, ff: s.fontFamily.split(',')[0].replace(/["']/g, '').trim(), tt: s.textTransform, text: own.slice(0, 2000) };
    if (a) row.href = a.href;
    row._b = Math.round(r.bottom + sy);
    rows.push(row);
  });
  rows.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
  // Photos. The hero is the image actually showing in the first screen: the topmost <img> or
  // background-image element under the screen centre (then 4 points around it), skipping text,
  // links and overlays without an image, and layers that are see-through (inactive slides).
  var MIN_W = 300, MIN_H = 200;
  var abs = function (u) { try { return new W.URL(u, W.location.href).href; } catch (e) { return u; } };
  var bgUrl = function (el, win) { var bg = (win || W).getComputedStyle(el).backgroundImage; var m = bg && bg.match(/url\\(["']?(.*?)["']?\\)/); return m ? m[1] : null; };
  // Opacity an element is heading to: a running opacity transition or animation counts at its
  // end value (headless capture browsers may not advance them, so the computed value is stale).
  var endOpacity = function (e, win) {
    var o = parseFloat(win.getComputedStyle(e).opacity);
    try {
      (e.getAnimations ? e.getAnimations() : []).forEach(function (a) {
        var k = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [];
        var last = k.length ? k[k.length - 1] : null;
        if (last && last.opacity !== undefined && last.opacity !== null && last.opacity !== '') o = parseFloat(last.opacity);
      });
    } catch (e2) {}
    return o;
  };
  var seenOpacity = function (el, win) {
    for (var e = el, o = 1; e && e.nodeType === 1; e = e.parentElement) { o *= endOpacity(e, win); if (!(o > 0.05)) return 0; }
    return o;
  };
  var findHero = function (doc, win, vw, vh) {
    if (!doc.elementsFromPoint) return null;
    // Builders often set pointer-events:none on background photos (Squarespace); hit-test them anyway.
    var pe = doc.createElement('style'); pe.textContent = '*{pointer-events:auto!important}';
    (doc.head || doc.documentElement).appendChild(pe);
    try {
      var pts = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
      for (var hp = 0; hp < pts.length; hp++) {
        var hstack = doc.elementsFromPoint(vw * pts[hp][0], vh * pts[hp][1]);
        for (var hs = 0; hs < hstack.length; hs++) {
          var he = hstack[hs];
          if (he === doc.body || he === doc.documentElement) break;
          if (he.id === '${FRAME_ID}') continue;
          if (!(he.tagName === 'IMG' && (he.currentSrc || he.src)) && !bgUrl(he, win)) continue;
          var hr0 = he.getBoundingClientRect();
          var heOp = seenOpacity(he, win);
          if (hr0.width < MIN_W || hr0.height < MIN_H || !heOp) continue;
          // A slider: other image layers of the same size at the same spot. Mid cross-fade, the
          // most visible layer wins (ties go to the topmost).
          var layers = hstack.filter(function (o) {
            if (o === he || !((o.tagName === 'IMG' && (o.currentSrc || o.src)) || bgUrl(o, win))) return false;
            var or = o.getBoundingClientRect();
            return Math.abs(or.left - hr0.left) <= 2 && Math.abs(or.top - hr0.top) <= 2 && Math.abs(or.width - hr0.width) <= 2 && Math.abs(or.height - hr0.height) <= 2;
          });
          var best = he, bestOp = heOp;
          layers.forEach(function (o) { var oo = seenOpacity(o, win); if (oo > bestOp + 0.01) { best = o; bestOp = oo; } });
          return { el: best, slider: layers.length > 0, layers: [he].concat(layers) };
        }
      }
      return null;
    } finally { pe.remove(); }
  };
  // Best source: the largest srcset/data-srcset candidate, else data-src, else currentSrc.
  var parseSrcset = function (set) {
    var out = [], i = 0, n = set.length;
    while (i < n) {
      while (i < n && /[\\s,]/.test(set.charAt(i))) i++;
      var st = i; while (i < n && !/\\s/.test(set.charAt(i))) i++;
      var u = set.slice(st, i), desc = '';
      if (/,$/.test(u)) u = u.replace(/,+$/, '');
      else { var ds = i; while (i < n && set.charAt(i) !== ',') i++; desc = set.slice(ds, i).trim(); }
      var dm = desc.match(/^(\\d+(?:\\.\\d+)?)([wx])$/i);
      if (u) out.push({ u: u, v: dm ? parseFloat(dm[1]) : 1, unit: dm ? dm[2].toLowerCase() : 'x' });
    }
    return out;
  };
  var bestSrc = function (im) {
    var c = parseSrcset(im.getAttribute('srcset') || '').concat(parseSrcset(im.getAttribute('data-srcset') || ''));
    var ws = c.filter(function (x) { return x.unit === 'w'; });
    var pool = ws.length ? ws : c;
    if (pool.length) return abs(pool.reduce(function (a, b) { return b.v > a.v ? b : a; }).u);
    var dsrc = im.getAttribute('data-src');
    if (dsrc) return abs(dsrc);
    return im.currentSrc || im.src;
  };
  var heroHit = findHero(D, W, W.innerWidth, SH);
  var heroEl = heroHit ? heroHit.el : null;
  // The screenshot window: its slider is stopped at the end so the screenshot shows this slide.
  var shotHit = !frame && heroHit && heroHit.slider ? heroHit : null;
  // The screenshot is of the top window, whose slideshow runs on its own clock: when reading
  // the frame, the hero is the photo the top window shows, if the frame has it too.
  var topHeroSrc = null;
  if (frame) {
    try {
      var topSH = window.innerHeight > 1500 ? (window.outerHeight > 0 && window.outerHeight <= 1500 ? window.outerHeight : 1080) : window.innerHeight;
      var th = findHero(document, window, Math.min(window.innerWidth, ${SCREEN_W}), topSH);
      if (th) { topHeroSrc = th.el.tagName === 'IMG' ? bestSrc(th.el) : abs(bgUrl(th.el, window)); shotHit = th.slider ? th : null; }
      else shotHit = null;
    } catch (e) {}
  }
  // Left out: entirely above the page, or opacity 0 / visibility hidden on themselves (unless the hero).
  var leaveOut = function (el, r) {
    var cs = W.getComputedStyle(el);
    return r.bottom + sy <= 0 || cs.visibility === 'hidden' || !(endOpacity(el, W) > 0);
  };
  var found = []; var seenEl = new Set();
  D.querySelectorAll('img').forEach(function (im) {
    var r = im.getBoundingClientRect();
    if (!(im.currentSrc || im.src || im.getAttribute('data-src') || im.getAttribute('data-srcset'))) return;
    if (r.width < MIN_W || r.height < MIN_H) return;
    seenEl.add(im);
    found.push({ el: im, out: leaveOut(im, r), c: { src: bestSrc(im), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + sy), alt: im.alt || '', kind: 'img' } });
  });
  D.querySelectorAll('body *').forEach(function (el) {
    if (seenEl.has(el)) return;
    var u = bgUrl(el);
    if (!u) return; var r = el.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return;
    found.push({ el: el, out: leaveOut(el, r), c: { src: abs(u), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + sy), alt: '', kind: 'background' } });
  });
  var heroAt = -1;
  if (topHeroSrc) found.forEach(function (x, i) { if (heroAt < 0 && x.c.src === topHeroSrc && x.c.y < SH && x.c.y + x.c.h > 0) heroAt = i; });
  // Only stop the top window's slider when its slide is the hero picked here (layouts can differ).
  if (frame && heroAt < 0) shotHit = null;
  if (heroAt < 0 && heroEl) found.forEach(function (x, i) { if (heroAt < 0 && x.el === heroEl) heroAt = i; });
  var imgs = []; var imgEl = new Map();
  if (heroAt >= 0) { found[heroAt].c.hero = true; imgs.push(found[heroAt].c); imgEl.set(found[heroAt].c, found[heroAt].el); }
  found.forEach(function (x, i) { if (i !== heroAt && !x.out) { imgs.push(x.c); imgEl.set(x.c, x.el); } });
  // Measure the content: the top window's scrollHeight follows its 100000px viewport, and
  // some builders (Pixieset) scroll an inner container, so the frame's scrollHeight is one screen.
  var pageHeight = 0;
  rows.forEach(function (r) { pageHeight = Math.max(pageHeight, r._b); });
  imgs.forEach(function (i) { pageHeight = Math.max(pageHeight, i.y + i.h); });
  if (frame) pageHeight = Math.max(pageHeight, D.documentElement.scrollHeight);
  rows.forEach(function (r) { delete r._b; });
  var docY = function (el) { return el.getBoundingClientRect().top + sy; };
  // Nav: short links at the top (first 180px), else at the bottom of the first screen.
  // Skip links, visually hidden links and the site-title link are left out; links inside the
  // nav element (or the element holding the most of them) win; duplicates dropped; max 8.
  var norm = function (t) { return (t || '').replace(/\\s+/g, ' ').trim(); };
  var siteNames = {};
  [D.title].concat(D.title.split(/\\s+[-|\u2013\u2014:\u00b7\u2022]\\s+/)).forEach(function (t) { if (norm(t)) siteNames[norm(t).toLowerCase()] = 1; });
  var ogName = D.querySelector('meta[property="og:site_name"]');
  if (ogName && ogName.content) siteNames[norm(ogName.content).toLowerCase()] = 1;
  var hiddenLink = function (a) {
    var r = a.getBoundingClientRect(); var s = W.getComputedStyle(a);
    if (r.width <= 1 || r.height <= 1 || r.right <= 0 || r.left >= W.innerWidth) return true;
    if (/^rect\\(0/.test(s.clip || '')) return true;
    return /sr-only|screen-reader|visually-hidden|skip-link/i.test(String(a.className || ''));
  };
  var skipLink = function (a, t) {
    var h = a.getAttribute('href') || '';
    return /^skip to/i.test(t) || h === '#main' || h === '#content' || h === '#main-content';
  };
  var navText = function (a, t) { return t && t.length < 30 && !skipLink(a, t) && !siteNames[t.toLowerCase()]; };
  var linkEls = arr(D.querySelectorAll('a')).filter(function (a) { var t = norm(a.innerText); return vis(a) && !hiddenLink(a) && navText(a, t); });
  var zoneTop = linkEls.filter(function (a) { return docY(a) < 180; });
  var zone = zoneTop.length ? zoneTop : linkEls.filter(function (a) { var y = docY(a); return y >= SH - 180 && y < SH; });
  var navTop = zoneTop.length > 0;
  var pickGroup = function (links, containers) {
    var best = null, bestN = 1;
    containers.forEach(function (c) {
      var n = links.filter(function (a) { return c.contains(a); }).length;
      if (n > bestN) { best = c; bestN = n; }
    });
    return best ? links.filter(function (a) { return best.contains(a); }) : null;
  };
  var navContainers = arr(D.querySelectorAll('header nav, nav, [role="navigation"]'));
  var navEls = pickGroup(zone, navContainers);
  if (!navEls) {
    // No nav element: the innermost ancestor (up to 5 levels, below body) that holds most
    // of the zone links (at least 2 and 60%), so a lone "Book now" beside the menu drops out.
    var need = Math.max(2, Math.ceil(zone.length * 0.6));
    var groups = [];
    zone.forEach(function (a) {
      for (var p = a.parentElement, k = 0; p && p !== D.body && p !== D.documentElement && k < 5; p = p.parentElement, k++) {
        if (groups.indexOf(p) < 0 && zone.filter(function (z) { return p.contains(z); }).length >= need) groups.push(p);
      }
    });
    var inner = groups.filter(function (g) { return !groups.some(function (o) { return o !== g && g.contains(o); }); });
    navEls = pickGroup(zone, inner) || zone;
  }
  var navLinks = navEls.map(function (a) { return norm(a.innerText); });
  if (!navLinks.length) {
    // Visible nav missing (burger menu): read the header nav's links by their text.
    var hidden = arr(D.querySelectorAll('header nav a, header [role="navigation"] a, [role="banner"] nav a'))
      .filter(function (a) { return navText(a, norm(a.textContent)); });
    if (hidden.length >= 2) {
      navLinks = hidden.map(function (a) { return norm(a.textContent); }); navTop = true;
      // The hidden links' colors are not what shows; style the nav from a visible header link.
      var hdr = hidden[0].closest('header,[role="banner"]');
      navEls = hdr ? arr(hdr.querySelectorAll('a')).filter(function (a) { return vis(a) && !hiddenLink(a); }).slice(0, 1) : [];
    }
  }
  if (!navLinks.length) {
    // Hamburger: a menu button in the top band. Read the hidden menu's links by their text;
    // if there are none, the site shows just "Menu" (never invent page names).
    var menuRe = /menu|hamburger|burger|nav-toggle/i;
    var menuBtn = arr(D.querySelectorAll('body *')).find(function (el) {
      if (el.id === '${FRAME_ID}') return false;
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.width > 300 || r.height > 150 || r.top + sy >= 180 || r.bottom <= 0) return false;
      var cs = W.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
      return /^menu$/i.test(norm(el.innerText)) || menuRe.test((el.getAttribute('aria-label') || '') + ' ' + cls(el));
    });
    if (menuBtn) {
      navLinks = arr(D.querySelectorAll('nav a, [role="navigation"] a, [class*="menu" i] a, [id*="menu" i] a'))
        .filter(function (a) { return !a.closest('footer,[role="contentinfo"]') && navText(a, norm(a.textContent)); })
        .map(function (a) { return norm(a.textContent); });
      if (!navLinks.length) navLinks = ['Menu'];
      navTop = true; navEls = [menuBtn];
    }
  }
  var seenNav = {};
  navLinks = navLinks.filter(function (t) { var k = t.toLowerCase(); if (seenNav[k]) return false; seenNav[k] = 1; return true; }).slice(0, 8);
  var navBg = null, navColor = null, navOverPhoto = false;
  var firstScreenImgs = imgs.filter(function (i) { return i.y < SH; }).sort(function (a, b) { return b.w * b.h - a.w * a.h; });
  // Nav style. "Over the photo" needs all three: (a) no solid background on the nav's walk
  // (link up to its header/fixed container, plus the header's large inner layers), (b) the
  // nav box overlapping the largest first-screen photo by at least half its height, and
  // (c) the elements under the nav bar (elementsFromPoint, skipping link text) being the photo.
  var solid = function (el) {
    var cs = W.getComputedStyle(el);
    if (!transparent(cs.backgroundColor)) return cs.backgroundColor;
    return null;
  };
  var bgImage = function (el) { var b = W.getComputedStyle(el).backgroundImage; return b && b !== 'none'; };
  if (navEls.length) {
    var link = navEls[0];
    navColor = W.getComputedStyle(link).color;
    var header = link.closest('header,[role="banner"]');
    if (!header) {
      for (var fx = link.parentElement; fx && fx !== D.body; fx = fx.parentElement) {
        var fp = W.getComputedStyle(fx).position;
        if (fp === 'fixed' || fp === 'sticky') { header = fx; break; }
      }
    }
    header = header || link.closest('nav') || link.parentElement || link;
    var hr = header.getBoundingClientRect();
    var hero = firstScreenImgs[0] || null;
    var heroEl = hero ? imgEl.get(hero) : null;
    var walkBg = null, walkImage = false;
    for (var we = link; we; we = we.parentElement) {
      var c0 = solid(we); if (c0) { walkBg = c0; break; }
      if (we !== link && bgImage(we) && we !== heroEl) { walkImage = true; break; }
      if (we === header) break;
    }
    if (!walkBg && !walkImage) {
      // Large inner layers: e.g. Squarespace's absolutely positioned header background div.
      var layers = arr(header.querySelectorAll('*')).filter(function (el) {
        if (el === heroEl || (heroEl && el.contains(heroEl))) return false;
        var r = el.getBoundingClientRect();
        return r.width >= hr.width * 0.8 && r.height >= hr.height * 0.5 && r.height <= hr.height * 1.5;
      });
      for (var li = 0; li < layers.length; li++) {
        var c1 = solid(layers[li]); if (c1) { walkBg = c1; break; }
        if (bgImage(layers[li])) { walkImage = true; break; }
      }
    }
    var hTop = hr.top + sy, hBottom = hTop + hr.height;
    var overlapOk = !!hero && hr.height > 0 && Math.min(hBottom, hero.y + hero.h) - Math.max(hTop, hero.y) >= hr.height * 0.5;
    // Cross-check under the bar, away from link text.
    var votesOver = 0, votesBar = 0, pointBg = null;
    if (heroEl && hr.height > 0 && D.elementsFromPoint) {
      var py = hr.top + hr.height / 2;
      [0.02, 0.25, 0.5, 0.75, 0.98].forEach(function (fxp) {
        var px = hr.left + hr.width * fxp;
        if (py < 0 || py >= W.innerHeight || px < 0 || px >= W.innerWidth) return;
        var stack = D.elementsFromPoint(px, py);
        if (stack.length && stack[0].closest('a,button')) return;
        for (var si = 0; si < stack.length; si++) {
          var se = stack[si];
          if (se === D.body || se === D.documentElement) break;
          if (se === heroEl || heroEl.contains(se) || (se.contains(heroEl) && !se.contains(header))) { votesOver++; return; }
          var c2 = solid(se);
          if (c2 || bgImage(se)) { votesBar++; if (c2 && !pointBg) pointBg = c2; return; }
        }
        votesBar++;
      });
    }
    var crossOver = votesOver + votesBar === 0 ? true : votesOver > votesBar;
    navOverPhoto = !walkBg && !walkImage && overlapOk && crossOver;
    if (!navOverPhoto) {
      navBg = walkBg || pointBg;
      if (!navBg) {
        for (var p = header.parentElement; p; p = p.parentElement) {
          var pc = W.getComputedStyle(p).backgroundColor;
          if (!transparent(pc)) { navBg = pc; break; }
        }
      }
      if (!navBg) navBg = '#FFFFFF';
    }
  }
  var logoEl = arr(D.querySelectorAll('img')).find(function (im) { var r = im.getBoundingClientRect(); return r.top + sy < 200 && r.width > 40 && (/logo/i.test(im.src + im.alt + im.className + ((im.closest('a,div') || {}).className || '')) || im.closest('header')); });
  var logo = null;
  if (logoEl) {
    logo = { src: logoEl.currentSrc || logoEl.src, w: Math.round(logoEl.getBoundingClientRect().width), h: Math.round(logoEl.getBoundingClientRect().height) };
  } else {
    // The brand link: the first link in the header with no text that holds an <img> or inline <svg>.
    var hdrBand = D.querySelector('header,[role="banner"]');
    var bandLinks = hdrBand ? arr(hdrBand.querySelectorAll('a')) : arr(D.querySelectorAll('a')).filter(function (a) { return docY(a) < 200; });
    for (var bl = 0; bl < bandLinks.length && !logo; bl++) {
      if (norm(bandLinks[bl].innerText)) continue;
      var mark = arr(bandLinks[bl].querySelectorAll('img,svg')).find(function (m) { var r = m.getBoundingClientRect(); return r.top + sy < 200 && r.width > 40 && r.height > 0; });
      if (!mark) continue;
      var mr = mark.getBoundingClientRect();
      if (mark.tagName === 'IMG') { logo = { src: mark.currentSrc || mark.src, w: Math.round(mr.width), h: Math.round(mr.height) }; break; }
      try {
        // Inline SVG: serialize it with its shown colors so it renders the same as a file.
        var svgC = mark.cloneNode(true);
        var origs = arr(mark.querySelectorAll('*')), clones = arr(svgC.querySelectorAll('*'));
        origs.forEach(function (o, oi) { var oc = W.getComputedStyle(o); if (clones[oi]) { clones[oi].setAttribute('fill', oc.fill); clones[oi].setAttribute('stroke', oc.stroke); } });
        svgC.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svgC.setAttribute('width', String(Math.round(mr.width))); svgC.setAttribute('height', String(Math.round(mr.height)));
        svgC.style.color = W.getComputedStyle(mark).color;
        logo = { src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new W.XMLSerializer().serializeToString(svgC)), w: Math.round(mr.width), h: Math.round(mr.height) };
      } catch (e) {}
    }
  }
  var firstScreen = rows.filter(function (r) { return r.y < SH; });
  var biggest = firstScreen.slice().sort(function (a, b) { return b.fs - a.fs; })[0];
  var bodyP = rows.find(function (r) { return r.tag === 'p' && r.text.length > 80; });
  var buttons = rows.filter(function (r) { return r.href && (r.tag === 'a' || r.tag === 'button' || r.tag === 'span') && r.text.length < 40; }).map(function (r) { return { text: r.text, href: r.href, y: r.y }; });
  // Accent: background of the first filled button-like link or button, top to bottom.
  var accent = null;
  var filled = arr(D.querySelectorAll('a,button,[role="button"]')).filter(function (el) {
    if (!vis(el)) return false;
    var t = (el.innerText || '').trim(); if (!t || t.length >= 40) return false;
    var r = el.getBoundingClientRect(); if (r.width > 600 || r.height < 20 || r.height > 120) return false;
    return !transparent(W.getComputedStyle(el).backgroundColor);
  }).sort(function (a, b) { return docY(a) - docY(b); });
  if (filled.length) accent = W.getComputedStyle(filled[0]).backgroundColor;
  var result = JSON.stringify({
    title: D.title, finalUrl: W.location.href, pageHeight: pageHeight,
    metaDesc: (D.querySelector('meta[name=description]') || {}).content || '',
    rows: rows, imgs: imgs, nav: navLinks,
    navTop: navTop, navOverPhoto: navOverPhoto, navBg: navBg, navColor: navColor,
    logo: logo,
    fonts: { heading: biggest ? biggest.ff : '', headingWeight: biggest ? biggest.fw : '', body: bodyP ? bodyP.ff : '' },
    uppercaseHeadings: biggest ? biggest.tt === 'uppercase' : false,
    accent: accent,
    buttons: buttons, textLength: D.body.innerText.length, sample: D.body.innerText.slice(0, 1500),
    frame: frame, screenH: SH
  });
  var hf = document.getElementById('${FRAME_ID}');
  if (hf) hf.remove();
  if (shotHit) {
    // Stop the slideshow (clear the page's timers, finish its transitions) and show the hero slide
    // fully, so the screenshot shows the slide found above; a running slider would move on first.
    // Timer functions are not replaced: the capture browser may still poll with them.
    try {
      var lastTimer = window.setTimeout(function () {}, 0);
      for (var ti = 0; ti <= lastTimer; ti++) { window.clearTimeout(ti); window.clearInterval(ti); }
      (document.getAnimations ? document.getAnimations() : []).forEach(function (a) { try { a.finish(); } catch (e) { a.pause(); } });
      var shared = shotHit.el.parentElement;
      while (shared && !shotHit.layers.every(function (l) { return shared.contains(l); })) shared = shared.parentElement;
      shotHit.layers.forEach(function (l) { if (l !== shotHit.el && !l.contains(shotHit.el)) l.style.setProperty('opacity', '0', 'important'); });
      for (var se1 = shotHit.el; se1 && se1 !== shared; se1 = se1.parentElement) se1.style.setProperty('opacity', '1', 'important');
    } catch (e) {}
  }
  return result;
})()`;
