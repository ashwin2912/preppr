/**
 * Served at /wf.js and pasted once into WhatsForm (Settings → Integrations →
 * Custom Script) as <script src="https://<PUBLIC_URL>/wf.js"></script>.
 *
 * On the public form it loads /public/menu.json from the same server, draws
 * today's dishes with +/− steppers, and writes the order into the form's text
 * question "Your order" ("2 × Dal 8oz, 4 × Roti (total $16)"), which reaches
 * our webhook and the owner's WhatsApp. Prices shown here are for the customer
 * only; the webhook prices the order again in code.
 *
 * If the script or the menu fails to load, the plain "Your order" box is left
 * as it is and customers type their order. No customer data is read or sent.
 *
 * Plain ES2017 in a string (the server has no DOM types). Keep it free of
 * backticks and "${".
 */
export const FORM_SCRIPT = String.raw`(function () {
  "use strict";
  if (window.__prepprForm) return;
  window.__prepprForm = 1;
  var me = document.currentScript;
  var base = me && me.src ? new URL(me.src).origin : "";
  var QUESTION = /^\s*(your\s+)?orders?(\s+details)?\s*\*?\s*$/i;
  var menu = null;
  var qty = {};
  var q = null;
  var box = null;

  function money(c) { return c % 100 === 0 ? "$" + c / 100 : "$" + (c / 100).toFixed(2); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function css() {
    var s = el("style");
    s.textContent =
      ".pp{border:1px solid #e3e3e3;border-radius:12px;padding:14px 14px 10px;margin:8px 0 18px;font:inherit;background:#fff}" +
      ".pp h3{margin:0 0 2px;font-size:18px}.pp .pp-sub{color:#666;font-size:13px;margin:0 0 10px}" +
      ".pp .pp-dish{padding:8px 0;border-top:1px solid #f0f0f0}.pp .pp-name{font-weight:600;margin-bottom:4px}" +
      ".pp .pp-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0}" +
      ".pp .pp-size{flex:1}.pp .pp-price{color:#444;min-width:52px;text-align:right}" +
      ".pp .pp-step{display:flex;align-items:center;gap:6px}" +
      ".pp .pp-step button{width:34px;height:34px;border-radius:50%;border:1px solid #25a244;background:#fff;color:#25a244;font-size:20px;line-height:1;cursor:pointer;padding:0}" +
      ".pp .pp-step button.pp-plus{background:#25a244;color:#fff}" +
      ".pp .pp-n{min-width:20px;text-align:center;font-weight:600}" +
      ".pp .pp-total{display:flex;justify-content:space-between;border-top:1px solid #e3e3e3;margin-top:6px;padding-top:10px;font-weight:700}" +
      ".pp .pp-err{color:#c0392b;font-size:14px;margin-top:6px}.pp .pp-closed{font-size:15px;color:#444}";
    document.head.appendChild(s);
  }

  // The "Your order" text question: the nearest label before a text input.
  function findQuestion() {
    var form = document.querySelector("form");
    if (!form) return null;
    var nodes = form.querySelectorAll("label, input, textarea");
    var last = null;
    for (var k = 0; k < nodes.length; k++) {
      var n = nodes[k];
      if (n.tagName === "LABEL") {
        if ((n.textContent || "").trim()) last = n;
        continue;
      }
      var text = n.tagName === "TEXTAREA" || n.type === "text";
      if (text && last && QUESTION.test(last.textContent || "")) return { form: form, label: last, input: n };
    }
    return null;
  }

  function setValue(input, v) {
    var proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function lines() {
    var out = [];
    var total = 0;
    menu.dishes.forEach(function (d) {
      d.sizes.forEach(function (s) {
        var n = qty[s.id] || 0;
        if (n > 0) {
          out.push(n + " × " + s.name);
          total += n * s.price_cents;
        }
      });
    });
    return { text: out.join(", "), total: total };
  }

  function render() {
    box.textContent = "";
    if (!menu.open) {
      box.appendChild(el("h3", null, menu.kitchen));
      box.appendChild(el("p", "pp-closed", "Orders are closed right now. Watch for our next menu!"));
      return;
    }
    box.appendChild(el("h3", null, "Menu for " + menu.day));
    box.appendChild(el("p", "pp-sub", menu.cutoff ? "Order by " + menu.cutoff + ". Tap + to add." : "Tap + to add."));
    menu.dishes.forEach(function (d) {
      var dish = el("div", "pp-dish");
      dish.appendChild(el("div", "pp-name", d.name));
      d.sizes.forEach(function (s) {
        var row = el("div", "pp-row");
        row.appendChild(el("span", "pp-size", s.label || ""));
        row.appendChild(el("span", "pp-price", s.price));
        var step = el("span", "pp-step");
        var minus = el("button", "pp-minus", "−");
        var n = el("span", "pp-n", String(qty[s.id] || 0));
        var plus = el("button", "pp-plus", "+");
        minus.type = plus.type = "button";
        minus.setAttribute("aria-label", "Remove one " + s.name);
        plus.setAttribute("aria-label", "Add one " + s.name);
        minus.onclick = function () { change(s.id, -1); };
        plus.onclick = function () { change(s.id, 1); };
        step.appendChild(minus); step.appendChild(n); step.appendChild(plus);
        row.appendChild(step);
        dish.appendChild(row);
      });
      box.appendChild(dish);
    });
    var t = lines();
    var total = el("div", "pp-total");
    total.appendChild(el("span", null, "Total"));
    total.appendChild(el("span", null, money(t.total)));
    box.appendChild(total);
    var err = el("div", "pp-err");
    err.id = "pp-err";
    box.appendChild(err);
  }

  function change(id, d) {
    qty[id] = Math.max(0, Math.min(99, (qty[id] || 0) + d));
    var t = lines();
    setValue(q.input, t.text ? t.text + " (total " + money(t.total) + ")" : "");
    render();
  }

  // Block submitting an empty order, or one after closing time.
  function guard(e) {
    if (!menu) return;
    var btn = e.type === "submit" ? null : e.target.closest && e.target.closest("button[type=submit]");
    if (e.type !== "submit" && !btn) return;
    var empty = !menu.open || !lines().text;
    if (!empty) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var err = document.getElementById("pp-err");
    if (err) err.textContent = "Tap + next to what you'd like first.";
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function mount() {
    if (box && document.contains(box)) return;
    q = findQuestion();
    if (!q) return;
    if (!box) {
      box = el("div", "pp");
      css();
      document.addEventListener("click", guard, true);
      document.addEventListener("submit", guard, true);
    }
    q.label.style.display = "none";
    q.input.style.display = "none";
    q.label.parentNode.insertBefore(box, q.label);
    render();
  }

  function start(data) {
    menu = data;
    mount();
    // React may redraw the form; put the menu back if it disappears.
    setInterval(mount, 1000);
  }

  var tries = 0;
  function waitForForm(data) {
    if (findQuestion()) return start(data);
    if (++tries < 100) setTimeout(function () { waitForForm(data); }, 200);
  }

  fetch(base + "/public/menu.json", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("menu " + r.status); return r.json(); })
    .then(waitForForm)
    .catch(function () {
      // Leave the plain question for the customer to type into.
      var found = findQuestion();
      if (found && !found.input.placeholder) found.input.placeholder = "e.g. 2 dal 8oz, 4 roti";
    });
})();
`;
