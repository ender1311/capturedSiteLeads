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
  // The top window reports a 100000px-tall viewport; fall back to its outer height for one screen.
  var SH = frame ? W.innerHeight : (W.innerHeight > 1500 ? (W.outerHeight > 0 && W.outerHeight <= 1500 ? W.outerHeight : 1080) : W.innerHeight);
`;

// Adds the hidden 1440x900 iframe of the same page. Returns a status string.
export const FRAME_SCRIPT = `(function () {
  if (document.getElementById('${FRAME_ID}')) return 'frame exists';
  var f = document.createElement('iframe');
  f.id = '${FRAME_ID}';
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  f.setAttribute('style', 'position:fixed;left:-20000px;top:0;width:${SCREEN_W}px;height:${SCREEN_H}px;border:0');
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
  var vis = function (el) { var r = el.getBoundingClientRect(); var s = W.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0; };
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
  var imgs = [];
  D.querySelectorAll('img').forEach(function (im) {
    var r = im.getBoundingClientRect(); var src = im.currentSrc || im.src;
    if (src && r.width >= 250 && r.height >= 160) imgs.push({ src: src, w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + sy), alt: im.alt || '', kind: 'img' });
  });
  D.querySelectorAll('body *').forEach(function (el) {
    var bg = W.getComputedStyle(el).backgroundImage; var m = bg && bg.match(/url\\(["']?(.*?)["']?\\)/);
    if (!m) return; var r = el.getBoundingClientRect();
    if (r.width >= 400 && r.height >= 250) imgs.push({ src: new URL(m[1], W.location.href).href, w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + sy), alt: '', kind: 'background' });
  });
  // Measure the content: the top window's scrollHeight follows its 100000px viewport, and
  // some builders (Pixieset) scroll an inner container, so the frame's scrollHeight is one screen.
  var pageHeight = 0;
  rows.forEach(function (r) { pageHeight = Math.max(pageHeight, r._b); });
  imgs.forEach(function (i) { pageHeight = Math.max(pageHeight, i.y + i.h); });
  if (frame) pageHeight = Math.max(pageHeight, D.documentElement.scrollHeight);
  rows.forEach(function (r) { delete r._b; });
  var linkEls = arr(D.querySelectorAll('a')).filter(function (a) { var t = a.innerText.trim(); return vis(a) && t && t.length < 30; });
  var docY = function (el) { return el.getBoundingClientRect().top + sy; };
  // Nav at the top (first 180px); if none, look at the bottom of the first screen.
  var navEls = linkEls.filter(function (a) { return docY(a) < 180; });
  var navTop = navEls.length > 0;
  if (!navEls.length) {
    navEls = linkEls.filter(function (a) { var y = docY(a); return y >= SH - 180 && y < SH; });
  }
  var navLinks = navEls.map(function (a) { return a.innerText.trim().replace(/\\s+/g, ' '); });
  var navBg = null, navColor = null, navOverPhoto = false;
  var firstScreenImgs = imgs.filter(function (i) { return i.y < SH; }).sort(function (a, b) { return b.w * b.h - a.w * a.h; });
  if (navEls.length) {
    var link = navEls[0];
    var header = link.closest('header,[role="banner"]') || link.closest('nav') || link.parentElement || link;
    var hs = W.getComputedStyle(header);
    navColor = W.getComputedStyle(link).color;
    var headerClear = transparent(hs.backgroundColor) && (!hs.backgroundImage || hs.backgroundImage === 'none');
    if (headerClear && firstScreenImgs.length) {
      var hr = header.getBoundingClientRect(); var hTop = hr.top + sy; var hBottom = hTop + hr.height;
      var big = firstScreenImgs[0];
      navOverPhoto = hTop < big.y + big.h && hBottom > big.y;
    }
    if (!transparent(hs.backgroundColor)) navBg = hs.backgroundColor;
    else if (!navOverPhoto) {
      for (var p = header.parentElement; p; p = p.parentElement) {
        var pc = W.getComputedStyle(p).backgroundColor;
        if (!transparent(pc)) { navBg = pc; break; }
      }
    }
  }
  var logoEl = arr(D.querySelectorAll('img')).find(function (im) { var r = im.getBoundingClientRect(); return r.top + sy < 200 && r.width > 40 && (/logo/i.test(im.src + im.alt + im.className + ((im.closest('a,div') || {}).className || '')) || im.closest('header')); });
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
    rows: rows, imgs: imgs, nav: Array.from(new Set(navLinks)).slice(0, 10),
    navTop: navTop, navOverPhoto: navOverPhoto, navBg: navBg, navColor: navColor,
    logo: logoEl ? { src: logoEl.currentSrc || logoEl.src, w: Math.round(logoEl.getBoundingClientRect().width), h: Math.round(logoEl.getBoundingClientRect().height) } : null,
    fonts: { heading: biggest ? biggest.ff : '', headingWeight: biggest ? biggest.fw : '', body: bodyP ? bodyP.ff : '' },
    uppercaseHeadings: biggest ? biggest.tt === 'uppercase' : false,
    accent: accent,
    buttons: buttons, textLength: D.body.innerText.length, sample: D.body.innerText.slice(0, 1500),
    frame: frame, screenH: SH
  });
  var hf = document.getElementById('${FRAME_ID}');
  if (hf) hf.remove();
  return result;
})()`;
