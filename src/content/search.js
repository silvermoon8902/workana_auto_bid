// search.js — runs on the Workana jobs search page.
// Scrapes visible job cards and reports them to the background worker.

(function () {
  const { textOf, qa, slugFromUrl, humanDelay } = window.WKDom;

  function scrapeCards() {
    const jobs = [];
    const seen = new Set();

    // Anchor to a job detail page is the most stable anchor point for a card.
    const anchors = qa("a[href*='/job/']");
    for (const a of anchors) {
      const slug = slugFromUrl(a.href);
      if (!slug || seen.has(slug)) continue;

      // Walk up to the card container (a block that also holds budget + bids text).
      let card = a;
      for (let i = 0; i < 6 && card.parentElement; i++) {
        card = card.parentElement;
        const t = textOf(card);
        if (/USD|R\$|bids|propuestas|propostas/i.test(t) && t.length > 60) break;
      }
      const blob = textOf(card);

      const title = textOf(a) || (blob.split("USD")[0] || "").slice(0, 120);
      const budget = (blob.match(/USD\s?[\d.,]+(?:\s?[-–]\s?[\d.,]+)?/i) || [])[0] || "";
      const bids = Number((blob.match(/Bids?:?\s*(\d+)/i) || [])[1] || 0);
      const country = (blob.match(/\b(Brazil|Brasil|Argentina|Mexico|México|Colombia|Chile|Peru|Perú|Spain|España|Venezuela|Ecuador|Uruguay|Bolivia|Paraguay|Portugal|United States|USA)\b/i) || [])[0] || "";

      seen.add(slug);
      jobs.push({ slug, url: a.href, title, budget, bids, country });
    }
    return jobs;
  }

  async function run() {
    await humanDelay(800, 1600); // let the SPA finish rendering
    const jobs = scrapeCards();
    chrome.runtime.sendMessage({ type: "JOBS_FOUND", jobs }).catch(() => {});
  }

  run();
})();
