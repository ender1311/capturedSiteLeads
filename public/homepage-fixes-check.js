/*
 * Captured Sites: on-page checks for the "Your Top Homepage Fixes" form.
 * Paste into an Elementor HTML widget on capturedsites.com/homepage-fixes/:
 *   <script src="https://captured-site-leads.vercel.app/homepage-fixes-check.js" defer></script>
 *
 * Checks the email and website fields (on blur, and 600 ms after typing stops)
 * against /api/homepage-fixes/check, shows the answer under the field, keeps
 * the submit button disabled until both pass, and blocks submit as a backstop.
 * Network errors, 429 and timeouts count as a pass: never block a real person
 * because we are slow.
 */
(function () {
  "use strict";

  var FORM_SELECTOR = 'form[name="Your Top Homepage Fixes"]';
  var DEBOUNCE_MS = 600;
  var REQUEST_TIMEOUT_MS = 3500;
  var RED = "#b42318";
  var TEAL = "#337A80";
  var PASS = { ok: true, code: "pass" };

  // The endpoint lives next to this script, so a local copy talks to local dev.
  var script = document.currentScript;
  var base = "https://captured-site-leads.vercel.app";
  try {
    if (script && script.src) base = new URL(script.src).origin;
  } catch { /* keep default */ }

  function init(form) {
    if (form.getAttribute("data-hf-check")) return;
    form.setAttribute("data-hf-check", "1");

    var submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
    var fields = {
      email: makeField("email", form.querySelector("#form-field-email")),
      site: makeField("site", form.querySelector("#form-field-site_url")),
    };
    if (!fields.email || !fields.site) return;

    function makeField(name, input) {
      if (!input) return null;
      var box = document.createElement("div");
      box.className = "hf-check";
      box.id = "hf-check-" + name;
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      box.style.marginTop = "4px";
      input.insertAdjacentElement("afterend", box);
      var described = input.getAttribute("aria-describedby");
      input.setAttribute("aria-describedby", (described ? described + " " : "") + box.id);
      return {
        name: name,
        input: input,
        box: box,
        checkedValue: null, // the value `result` belongs to
        result: null,
        pending: null, // { value, promise }
        timer: null,
        reported: {}, // values already sent to bfm
      };
    }

    function current(f) {
      return f.input.value.trim();
    }

    function passing(f) {
      var v = current(f);
      return v !== "" && f.checkedValue === v && f.result && f.result.ok === true;
    }

    function updateButton() {
      if (submitButton) submitButton.disabled = !(passing(fields.email) && passing(fields.site));
    }

    function render(f) {
      var box = f.box;
      var r = f.checkedValue === current(f) ? f.result : null;
      while (box.firstChild) box.removeChild(box.firstChild);
      f.input.removeAttribute("aria-invalid");
      if (!r) return;
      if (!r.ok && r.message) {
        box.style.color = RED;
        box.textContent = r.message;
        f.input.setAttribute("aria-invalid", "true");
        track(f);
      } else if (r.ok && r.code === "typo" && r.suggestion) {
        box.style.color = TEAL;
        var fix = document.createElement("button");
        fix.type = "button";
        fix.textContent = r.suggestion;
        fix.style.cssText =
          "background:none;border:0;padding:0;margin:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer;";
        fix.addEventListener("click", function () {
          f.input.value = r.suggestion;
          f.input.dispatchEvent(new Event("input", { bubbles: true }));
          f.input.dispatchEvent(new Event("change", { bubbles: true }));
          runCheck(f);
        });
        box.appendChild(document.createTextNode("Did you mean "));
        box.appendChild(fix);
        box.appendChild(document.createTextNode("?"));
      }
    }

    function request(name, value) {
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
      }, REQUEST_TIMEOUT_MS);
      var url = base + "/api/homepage-fixes/check?" + name + "=" + encodeURIComponent(value);
      return fetch(url, { method: "GET", credentials: "omit", signal: controller ? controller.signal : undefined })
        .then(function (res) {
          if (!res.ok) return PASS; // 429 slow_down and server errors pass
          return res.json().then(function (body) {
            var r = body && body[name];
            return r && typeof r.ok === "boolean" ? r : PASS;
          });
        })
        .catch(function () {
          return PASS;
        })
        .then(function (r) {
          clearTimeout(timer);
          return r;
        });
    }

    // Resolves with the result for the field's value at call time.
    function runCheck(f) {
      clearTimeout(f.timer);
      var value = current(f);
      if (value === "") {
        f.checkedValue = null;
        f.result = null;
        render(f);
        updateButton();
        return Promise.resolve(null);
      }
      if (f.checkedValue === value && f.result) return Promise.resolve(f.result);
      if (f.pending && f.pending.value === value) return f.pending.promise;
      var promise = request(f.name, value).then(function (r) {
        if (f.pending && f.pending.value === value) f.pending = null;
        if (current(f) === value) {
          f.checkedValue = value;
          f.result = r;
          render(f);
          updateButton();
        }
        return r;
      });
      f.pending = { value: value, promise: promise };
      return promise;
    }

    function watch(f) {
      f.input.addEventListener("input", function () {
        render(f); // hides a message that belonged to the old value
        updateButton();
        clearTimeout(f.timer);
        f.timer = setTimeout(function () {
          runCheck(f);
        }, DEBOUNCE_MS);
      });
      f.input.addEventListener("blur", function () {
        runCheck(f);
      });
    }

    // Reports a blocked value to the Beacon Frontier collector, once per
    // distinct value per field (shown message and blocked submit count once).
    function track(f) {
      var value = current(f);
      if (f.reported[value]) return;
      f.reported[value] = true;
      if (typeof window.bfm === "function") {
        try {
          window.bfm("hf_check_blocked", { field: f.name });
        } catch { /* analytics must never break the form */ }
      }
    }

    watch(fields.email);
    watch(fields.site);

    // Capture on document so this runs before Elementor's own submit handler.
    var resubmitting = false;
    document.addEventListener(
      "submit",
      function (event) {
        if (event.target !== form) return;
        if (passing(fields.email) && passing(fields.site)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (resubmitting) return;
        resubmitting = true;
        Promise.all([runCheck(fields.email), runCheck(fields.site)]).then(function () {
          resubmitting = false;
          var failing = ["email", "site"].filter(function (n) {
            return !passing(fields[n]);
          });
          if (failing.length === 0) {
            if (typeof form.requestSubmit === "function") form.requestSubmit(submitButton || undefined);
            return;
          }
          failing.forEach(function (n) {
            track(fields[n]);
          });
          var first = fields[failing[0]].input;
          if (first && typeof first.focus === "function") first.focus();
        });
      },
      true
    );

    // Elementor resets the form after a successful send.
    form.addEventListener("reset", function () {
      setTimeout(function () {
        [fields.email, fields.site].forEach(function (f) {
          clearTimeout(f.timer);
          f.checkedValue = null;
          f.result = null;
          f.pending = null;
          render(f);
        });
        updateButton();
      }, 0);
    });

    // Values the browser autofilled before this script ran.
    [fields.email, fields.site].forEach(function (f) {
      if (current(f) !== "") runCheck(f);
    });
    updateButton();
  }

  function start() {
    var form = document.querySelector(FORM_SELECTOR);
    if (form) return init(form);
    if (typeof MutationObserver !== "function") return;
    var observer = new MutationObserver(function () {
      var found = document.querySelector(FORM_SELECTOR);
      if (found) {
        observer.disconnect();
        init(found);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
