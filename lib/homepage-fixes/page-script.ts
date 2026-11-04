// In-page scripts for Firecrawl `executeJavascript` actions.
// Ported from the skill's scripts/capture.mjs (dismiss() and the page.evaluate body).
// They run inside the scraped page, so they are plain ES2017 strings with no imports
// (no optional chaining, no nullish coalescing, no object spread).

// capture.mjs dismiss(): click consent/close buttons, press Escape, then remove large
// fixed overlays that still cover the page. Returns the removed popups' texts.
export const DISMISS_SCRIPT = `(function () {
  var out = [];
  // Firecrawl's action browser reports a 1920x100000 viewport (it renders everything at once),
  // so innerHeight is not a screen. Fall back to the window's outer height for 'one screen'.
  var SH = innerHeight > 1500 ? (outerHeight > 0 && outerHeight <= 1500 ? outerHeight : 1080) : innerHeight;
  var visible = function (el) {
    var r = el.getBoundingClientRect(); var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0;
  };
  var names = ['Accept all', 'Accept All', 'Accept', 'I agree', 'Got it', 'OK', 'No thanks', 'No, thanks', 'Close', 'Dismiss'];
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
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
    try { var el = document.querySelector(sel); if (el && visible(el)) el.click(); } catch (e) {}
  });
  try {
    var esc = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', esc));
    document.dispatchEvent(new KeyboardEvent('keydown', esc));
  } catch (e) {}
  // Large fixed overlays (popups) that still cover the page. Headers are small, so they stay.
  var all = Array.prototype.slice.call(document.querySelectorAll('body *'));
  for (var j = 0; j < all.length; j++) {
    var el = all[j];
    if (!el.isConnected) continue;
    var s = getComputedStyle(el);
    if (s.position !== 'fixed') continue;
    var r = el.getBoundingClientRect();
    var text = (el.innerText || '').trim();
    // Only real popups: they have words or are dialogs. Empty fixed layers can be the hero photo.
    var popup = text.length > 0 || el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';
    if (popup && +s.zIndex >= 10 && Math.min(r.height, SH) * r.width > innerWidth * SH * 0.3) { out.push(text.slice(0, 80)); el.remove(); }
  }
  document.documentElement.style.overflow = 'auto'; document.body.style.overflow = 'auto';
  return out;
})()`;

// capture.mjs page.evaluate body, plus navTop, navOverPhoto, navBg, navColor,
// uppercaseHeadings and accent. Returns JSON.stringify(PageData without `dismissed`).
export const EXTRACT_SCRIPT = `(function () {
  window.scrollTo(0, 0);
  // Firecrawl's action browser reports a 1920x100000 viewport (it renders everything at once),
  // so innerHeight is not a screen. Fall back to the window's outer height for 'one screen'.
  var SH = innerHeight > 1500 ? (outerHeight > 0 && outerHeight <= 1500 ? outerHeight : 1080) : innerHeight;
  var vis = function (el) { var r = el.getBoundingClientRect(); var s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0; };
  var arr = function (list) { return Array.prototype.slice.call(list); };
  var transparent = function (c) {
    if (!c || c === 'transparent') return true;
    var m = c.match(/rgba?\\(([^)]*)\\)/);
    if (!m) return false;
    var parts = m[1].split(/[\\s,\\/]+/).filter(Boolean);
    return parts.length >= 4 && parseFloat(parts[3]) === 0;
  };
  var rows = [];
  document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,button,li,span,div,em,strong,b,label,blockquote,figcaption').forEach(function (el) {
    if (!vis(el)) return;
    var own = arr(el.childNodes).filter(function (x) { return x.nodeType === 3; }).map(function (x) { return x.textContent.trim(); }).join(' ').replace(/\\s+/g, ' ').trim();
    if (!own || own.length < 2) return;
    var r = el.getBoundingClientRect(); var s = getComputedStyle(el); var a = el.closest('a');
    var row = { tag: el.tagName.toLowerCase(), y: Math.round(r.top + scrollY), x: Math.round(r.left), fs: parseFloat(s.fontSize), fw: s.fontWeight, ff: s.fontFamily.split(',')[0].replace(/["']/g, '').trim(), tt: s.textTransform, text: own.slice(0, 2000) };
    if (a) row.href = a.href;
    rows.push(row);
  });
  rows.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
  var imgs = [];
  document.querySelectorAll('img').forEach(function (im) {
    var r = im.getBoundingClientRect(); var src = im.currentSrc || im.src;
    if (src && r.width >= 250 && r.height >= 160) imgs.push({ src: src, w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + scrollY), alt: im.alt || '', kind: 'img' });
  });
  document.querySelectorAll('body *').forEach(function (el) {
    var bg = getComputedStyle(el).backgroundImage; var m = bg && bg.match(/url\\(["']?(.*?)["']?\\)/);
    if (!m) return; var r = el.getBoundingClientRect();
    if (r.width >= 400 && r.height >= 250) imgs.push({ src: new URL(m[1], location.href).href, w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + scrollY), alt: '', kind: 'background' });
  });
  var linkEls = arr(document.querySelectorAll('a')).filter(function (a) { var t = a.innerText.trim(); return vis(a) && t && t.length < 30; });
  var docY = function (el) { return el.getBoundingClientRect().top + scrollY; };
  // Nav at the top (first 180px); if none, look at the bottom of the first screen.
  var navEls = linkEls.filter(function (a) { return docY(a) < 180; });
  var navTop = true;
  if (!navEls.length) {
    var bottom = linkEls.filter(function (a) { var y = docY(a); return y >= SH - 180 && y < SH; });
    if (bottom.length) { navEls = bottom; navTop = false; }
  }
  var navLinks = navEls.map(function (a) { return a.innerText.trim().replace(/\\s+/g, ' '); });
  var navBg = null, navColor = null, navOverPhoto = false;
  var firstScreenImgs = imgs.filter(function (i) { return i.y < SH; }).sort(function (a, b) { return b.w * b.h - a.w * a.h; });
  if (navEls.length) {
    var link = navEls[0];
    var header = link.closest('header,[role="banner"]') || link.closest('nav') || link.parentElement || link;
    var hs = getComputedStyle(header);
    navColor = getComputedStyle(link).color;
    var headerClear = transparent(hs.backgroundColor) && (!hs.backgroundImage || hs.backgroundImage === 'none');
    if (headerClear && firstScreenImgs.length) {
      var hr = header.getBoundingClientRect(); var hTop = hr.top + scrollY; var hBottom = hTop + hr.height;
      var big = firstScreenImgs[0];
      navOverPhoto = hTop < big.y + big.h && hBottom > big.y;
    }
    if (!transparent(hs.backgroundColor)) navBg = hs.backgroundColor;
    else if (!navOverPhoto) {
      for (var p = header.parentElement; p; p = p.parentElement) {
        var pc = getComputedStyle(p).backgroundColor;
        if (!transparent(pc)) { navBg = pc; break; }
      }
    }
  }
  var logoEl = arr(document.querySelectorAll('img')).find(function (im) { var r = im.getBoundingClientRect(); return r.top + scrollY < 200 && r.width > 40 && (/logo/i.test(im.src + im.alt + im.className + ((im.closest('a,div') || {}).className || '')) || im.closest('header')); });
  var firstScreen = rows.filter(function (r) { return r.y < SH; });
  var biggest = firstScreen.slice().sort(function (a, b) { return b.fs - a.fs; })[0];
  var bodyP = rows.find(function (r) { return r.tag === 'p' && r.text.length > 80; });
  var buttons = rows.filter(function (r) { return r.href && (r.tag === 'a' || r.tag === 'button' || r.tag === 'span') && r.text.length < 40; }).map(function (r) { return { text: r.text, href: r.href, y: r.y }; });
  // Accent: background of the first filled button-like link or button, top to bottom.
  var accent = null;
  var filled = arr(document.querySelectorAll('a,button,[role="button"]')).filter(function (el) {
    if (!vis(el)) return false;
    var t = (el.innerText || '').trim(); if (!t || t.length >= 40) return false;
    var r = el.getBoundingClientRect(); if (r.width > 600 || r.height < 20 || r.height > 120) return false;
    return !transparent(getComputedStyle(el).backgroundColor);
  }).sort(function (a, b) { return docY(a) - docY(b); });
  if (filled.length) accent = getComputedStyle(filled[0]).backgroundColor;
  return JSON.stringify({
    title: document.title, finalUrl: location.href, pageHeight: document.documentElement.scrollHeight,
    metaDesc: (document.querySelector('meta[name=description]') || {}).content || '',
    rows: rows, imgs: imgs, nav: Array.from(new Set(navLinks)).slice(0, 10),
    navTop: navTop, navOverPhoto: navOverPhoto, navBg: navBg, navColor: navColor,
    logo: logoEl ? { src: logoEl.currentSrc || logoEl.src, w: Math.round(logoEl.getBoundingClientRect().width), h: Math.round(logoEl.getBoundingClientRect().height) } : null,
    fonts: { heading: biggest ? biggest.ff : '', headingWeight: biggest ? biggest.fw : '', body: bodyP ? bodyP.ff : '' },
    uppercaseHeadings: biggest ? biggest.tt === 'uppercase' : false,
    accent: accent,
    buttons: buttons, textLength: document.body.innerText.length, sample: document.body.innerText.slice(0, 1500)
  });
})()`;
