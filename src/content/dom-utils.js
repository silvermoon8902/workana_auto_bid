// dom-utils.js — shared helpers + ALL fragile selectors in one place.
// Loaded FIRST in every content-script group; exposes everything on window.WKDom.
//
// ⚠️ Workana ships obfuscated/changing CSS classes. Prefer the text/aria/structural
// strategies below. When a flow breaks, fix the selector HERE only.

(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Randomized human-like pause (anti-automation throttling).
  const humanDelay = (min = 600, max = 1800) =>
    sleep(Math.floor(min + Math.random() * (max - min)));

  function textOf(el) {
    return (el?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function qa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  // Wait until selector exists (or timeout). Returns element or null.
  async function waitForSelector(sel, { timeout = 12000, root = document } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = root.querySelector(sel);
      if (el) return el;
      await sleep(200);
    }
    return null;
  }

  // Wait until an element whose visible text matches `re` appears.
  async function waitForText(re, { timeout = 12000, selector = "*" } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = qa(selector).find((e) => re.test(textOf(e)));
      if (el) return el;
      await sleep(200);
    }
    return null;
  }

  // Find the nearest clickable (button/link) whose text matches.
  function findClickableByText(re, root = document) {
    const candidates = qa("button, a, [role='button'], [role='tab'], div", root);
    return candidates.find((el) => re.test(textOf(el)) && el.offsetParent !== null) || null;
  }

  async function clickByText(re, opts = {}) {
    const el = (await waitForText(re, { selector: "button, a, [role='button'], [role='tab']", ...opts })) ||
      findClickableByText(re);
    if (!el) return false;
    el.click();
    return true;
  }

  // Set a value on a React-controlled <input>/<textarea> so React picks it up.
  function setReactValue(el, value) {
    if (!el) return false;
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Extract the job slug from a Workana job/bid URL.
  function slugFromUrl(url) {
    const m = String(url).match(/workana\.com\/(?:job|messages\/bid)\/([^/?#]+)/i);
    return m ? m[1] : null;
  }

  // Find the editable input/textarea that belongs to a labelled field
  // (e.g. "Total rate", "Proposal details") — checks siblings after the label
  // first, then the label's parent. Skips disabled/readonly (Service Fee etc.).
  function inputAfterLabel(re) {
    const labels = qa("label, strong, h4, p, span, div").filter(
      (e) => re.test(textOf(e)) && textOf(e).length < 60
    );
    const ok = (el) =>
      el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && !el.disabled && !el.readOnly;
    for (const lbl of labels) {
      let n = lbl.nextElementSibling;
      while (n) {
        if (ok(n)) return n;
        const inp = n.querySelector && n.querySelector("input:not([disabled]):not([readonly]), textarea");
        if (inp) return inp;
        n = n.nextElementSibling;
      }
      const p = lbl.parentElement;
      const inp = p && p.querySelector("input:not([disabled]):not([readonly]), textarea");
      if (inp) return inp;
    }
    return null;
  }

  // Defuse Workana's anti-contact/anti-link filter (which can SUSPEND the account):
  // break risky trigger words and domain/link dots with a space so they aren't
  // recognized as contact info, external links, or domains.
  // e.g. "WhatsApp" -> "What sApp", "Fee" -> "Fe e", "next.js" -> "next. js",
  //      "serenium-wellness.com" -> "serenium-wellness. com".
  const TRIGGER_WORDS = [
    { re: /whatsapp/gi, at: 4 },
    { re: /telegram/gi, at: 4 },
    { re: /fee/gi, at: 2 }, // also breaks "Feedback" -> "Fe edback"
    { re: /tax/gi, at: 2 }, // also breaks "Taxes" -> "Ta xes"
  ];
  function sanitizeOutgoing(text) {
    if (!text) return text;
    let t = String(text);
    for (const { re, at } of TRIGGER_WORDS) {
      t = t.replace(re, (m) => m.slice(0, at) + " " + m.slice(at));
    }
    // Break a dot only when it's immediately followed by a non-space, non-dot
    // char — i.e. domain/version/link dots ("x.y"), not normal sentence dots.
    t = t.replace(/\.(?=[^\s.])/g, ". ");
    return t;
  }

  // Read "Minimum bid: USD 1,800.00" from the bid form, if shown.
  function readMinBid() {
    const m = textOf(document.body).match(/Minimum bid:\s*USD?\s*\$?\s*([\d.,]+)/i);
    if (!m) return null;
    return Number(m[1].replace(/[.,](?=\d{3}\b)/g, ""));
  }

  // ---- SELECTORS / label patterns (verify against live DOM) ----
  const S = {
    // Search results page
    jobCard: "[class*='project'] a[href*='/job/'], a[href*='/job/']",
    jobCardContainer: "div", // a job card block; resolved structurally in search.js
    placeBidText: /place a bid|enviar (proposta|propuesta)|fazer (uma )?proposta|hacer una oferta/i,
    insightsTabText: /project insights|insights del proyecto|insights do projeto/i,
    askQuestionText: /ask a question|make questions|hacer preguntas|fazer perguntas/i,

    // Bid form fields
    skillChip: "[class*='skill'] [class*='chip'], [class*='tag']",
    skillSearchInput: "input[placeholder*='skill' i], input[placeholder*='habilidad' i], input[placeholder*='habilidade' i]",
    portfolioCard: "[class*='portfolio'] [class*='card'], [class*='project-card']",
    addProjectButton: "button, [role='button']", // the '+' on each portfolio card; resolved in job.js
    totalRateInput: "input[placeholder*='USD' i], input[type='number']",
    proposalTextarea: "textarea",
    deliveryInput: "input[placeholder*='days' i], input[placeholder*='día' i], input[placeholder*='dias' i]",
    submitBidText: /^submit$|^enviar$|^send$/i,

    // Messages / chat
    conversationItem: "[class*='conversation'] [class*='item'], [class*='thread'] a, [class*='chat-list'] li",
    unreadBadge: "[class*='unread'], [class*='new'], [class*='badge']",
    messageBubble: "[class*='message'] [class*='bubble'], [class*='msg']",
    replyBox: "textarea[placeholder*='reply' i], textarea[placeholder*='mensaje' i], textarea[placeholder*='mensagem' i], div[contenteditable='true']",
    sendButton: "button[type='submit'], [class*='send']",
  };

  window.WKDom = {
    sleep,
    humanDelay,
    textOf,
    qa,
    waitForSelector,
    waitForText,
    findClickableByText,
    clickByText,
    setReactValue,
    slugFromUrl,
    inputAfterLabel,
    readMinBid,
    sanitizeOutgoing,
    S,
  };
})();
