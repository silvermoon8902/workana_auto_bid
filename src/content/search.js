// search.js — runs on the Workana jobs search page.
// Self-polls the visible job cards and reports them to the background worker,
// so it keeps working even when "Start" is pressed AFTER the page loaded.

(function () {
  const { textOf, qa, slugFromUrl, humanDelay } = window.WKDom;

  // Pull "Published: 15 / Payments: 2" + country out of the author popover.
  function clientFromCard(card) {
    const btn = card.querySelector("button[data-content]");
    let publishedCount = 0,
      paidCount = 0;
    if (btn) {
      const html = btn.getAttribute("data-content") || "";
      const txt = html.replace(/<[^>]+>/g, " ");
      publishedCount = Number((txt.match(/Published:\s*(\d+)/i) || [])[1] || 0);
      paidCount = Number((txt.match(/Payments?:\s*(\d+)/i) || [])[1] || 0);
    }
    const country =
      textOf(card.querySelector(".country-name")) ||
      (card.querySelector(".flag")?.getAttribute("title") || "");
    const clientName = textOf(card.querySelector(".user-name")) || "";
    return { publishedCount, paidCount, country, clientName };
  }

  function scrapeCards() {
    const jobs = [];
    const seen = new Set();
    const cards = qa(".project-item, .js-project");
    for (const card of cards) {
      const a = card.querySelector("a[href*='/job/']:not([href*='/job/insight/'])");
      if (!a) continue;
      const slug = slugFromUrl(a.href);
      if (!slug || slug === "insight" || seen.has(slug)) continue; // never the insights sub-route
      seen.add(slug);

      const title = textOf(a);
      const snippet = textOf(card.querySelector(".html-desc, .project-details")) || "";
      const budget = textOf(card.querySelector(".budget .values, .budget")) || "";
      const bids = Number((textOf(card).match(/Bids?:?\s*(\d+)/i) || [])[1] || 0);
      const client = clientFromCard(card);

      jobs.push({ slug, url: a.href, title, snippet, budget, bids, ...client });
    }
    return jobs;
  }

  async function run() {
    await humanDelay(500, 1100); // let the SPA settle
    const jobs = scrapeCards();
    if (jobs.length) {
      console.debug("[WK search] reporting", jobs.length, "jobs");
      chrome.runtime.sendMessage({ type: "JOBS_FOUND", jobs }).catch(() => {});
    }
  }

  // React to "Start" pressed after load.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "RESCAN") run();
  });

  run();
  setInterval(run, 15_000);
})();
