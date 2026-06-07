// job.js — runs on /job/<slug> (detail) AND /messages/bid/<slug> (bid form).
// Phase is decided by URL. Coordinates with the background state machine.

(function () {
  const D = window.WKDom;
  const { textOf, qa, slugFromUrl, waitForSelector, waitForText, clickByText, setReactValue, humanDelay, sleep, inputAfterLabel, readMinBid, sanitizeOutgoing, S } = D;

  const slug = slugFromUrl(location.href);
  const isBidForm = /\/messages\/bid\//i.test(location.pathname);

  const send = (msg) => chrome.runtime.sendMessage(msg);

  // ---------- shared scraping ----------
  function getBodyText() {
    return textOf(document.body);
  }

  function getDescription() {
    const heading = qa("h1,h2,h3,h4,strong,div,span").find((e) =>
      /about this project|sobre (el|o) proyecto|sobre o projeto|descripción/i.test(textOf(e))
    );
    if (heading) {
      let c = heading;
      for (let i = 0; i < 4 && c.parentElement; i++) c = c.parentElement;
      const t = textOf(c);
      if (t.length > 120) return t.slice(0, 4000);
    }
    // Fallback: largest paragraph-ish block.
    const blocks = qa("p, [class*='description'], [class*='about']")
      .map(textOf)
      .filter((t) => t.length > 120)
      .sort((a, b) => b.length - a.length);
    return (blocks[0] || getBodyText()).slice(0, 4000);
  }

  function getClientPanel() {
    const body = getBodyText();
    // Numbers may appear BEFORE the label ("4 Published projects") on the detail
    // page, or AFTER it ("Published: 3 / Payments: 2") on the bid page.
    const pick = (patterns) => {
      for (const p of patterns) {
        const m = body.match(p);
        if (m) return Number(m[1]);
      }
      return 0;
    };
    const publishedCount = pick([
      /(\d+)\s*Published projects/i,
      /Published projects?\D{0,6}(\d+)/i,
      /Published:\s*(\d+)/i,
    ]);
    const paidCount = pick([
      /(\d+)\s*Projects paid/i,
      /Projects paid\D{0,6}(\d+)/i,
      /Payments?:\s*(\d+)/i,
    ]);
    const clientName =
      textOf(qa("[class*='client'] [class*='name'], [class*='author']")[0]) || "";
    const country =
      (body.match(/\b(Brazil|Brasil|Argentina|Mexico|México|Colombia|Chile|Peru|Perú|Spain|España|Venezuela|Ecuador|Uruguay|Bolivia|Paraguay|Portugal|United States|USA)\b/i) || [])[0] || "";
    return { publishedCount, paidCount, clientName, country };
  }

  async function readInsightsAverage() {
    try {
      const tab = await waitForText(S.insightsTabText, { selector: "button,a,[role='tab'],div", timeout: 4000 });
      if (!tab) return null;
      tab.click();
      await humanDelay(900, 1600);
      const node = await waitForText(/average/i, { selector: "*", timeout: 4000 });
      const around = node ? textOf(node.parentElement || node) : "";
      const m = around.match(/USD?\s?\$?\s?([\d.,]+)/i);
      // Switch back to the Project tab so a later "Place a bid" is visible.
      await clickByText(/^project$|^proyecto$|^projeto$/i, { timeout: 1500 });
      return m ? Number(m[1].replace(/[.,](?=\d{3}\b)/g, "")) : null;
    } catch {
      return null;
    }
  }

  // ---------- Phase A: job detail ----------
  async function runDetail() {
    await humanDelay(900, 1700);
    const description = getDescription();
    const client = getClientPanel();
    const avgPrice = await readInsightsAverage();

    const resp = await send({
      type: "JOB_DETAIL",
      slug,
      data: { description, postingText: description, avgPrice, ...client },
    });

    if (!resp || resp.action === "skip" || resp.action === "abort") return; // background closes the tab

    // action === "bid" → open the bid form.
    await humanDelay();
    const clicked = await clickByText(S.placeBidText, { timeout: 6000 });
    if (!clicked) {
      await send({ type: "BID_DONE", slug, success: false, error: "Place-a-bid button not found" });
    }
    // Navigation to /messages/bid/<slug> triggers job.js again in bid-form mode.
  }

  // ---------- Phase B: bid form ----------
  async function selectSkills(want = []) {
    // 1) Tick existing candidate chips that match.
    const chips = qa(S.skillChip).filter((c) => c.offsetParent !== null);
    let chosen = 0;
    const lc = (s) => s.toLowerCase();
    for (const chip of chips) {
      if (chosen >= 5) break;
      const label = lc(textOf(chip));
      if (want.some((w) => lc(w) && label.includes(lc(w)))) {
        chip.click();
        chosen++;
        await sleep(150);
      }
    }
    // 2) If fewer than 5, search-add from Claude's suggestions.
    if (chosen < 5) {
      const input = document.querySelector(S.skillSearchInput);
      if (input) {
        for (const w of want) {
          if (chosen >= 5) break;
          setReactValue(input, w);
          await humanDelay(500, 900);
          const opt = await waitForText(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), {
            selector: "li,[role='option'],div",
            timeout: 1500,
          });
          if (opt) {
            opt.click();
            chosen++;
            await sleep(200);
          }
        }
      }
    }
    return chosen;
  }

  async function selectProjects(wantTitles = []) {
    const cards = qa(S.portfolioCard).filter((c) => c.offsetParent !== null);
    let chosen = 0;
    for (const card of cards) {
      if (chosen >= 3) break;
      const title = textOf(card).toLowerCase();
      if (wantTitles.some((t) => t && title.includes(t.toLowerCase()))) {
        const plus =
          card.querySelector("button, [role='button'], [class*='add'], svg") ||
          card.querySelector(S.addProjectButton);
        if (plus) {
          plus.click();
          chosen++;
          await sleep(200);
        }
      }
    }
    return chosen;
  }

  async function fillBudget(price) {
    // Target the "Total rate" input specifically — NOT "Work hours" (the first
    // number field). Putting the bid in Hours makes Workana auto-inflate Total.
    const input = inputAfterLabel(/total rate/i) || (await waitForSelector(S.totalRateInput, { timeout: 4000 }));
    if (!input) return;
    let val = Math.round(Number(price) || 0);
    const min = readMinBid();
    if (min && val < min) val = Math.ceil(min / 10) * 10; // respect the form's minimum bid
    if (val > 0) setReactValue(input, String(val));
  }

  async function fillProposal(text) {
    const ta = inputAfterLabel(/proposal details/i) || (await waitForSelector(S.proposalTextarea, { timeout: 4000 }));
    if (!ta || !text) return;
    // Defuse Workana's link/contact filter so the bid isn't blocked/suspended.
    const safe = sanitizeOutgoing(text);
    if (ta.isContentEditable) {
      ta.focus();
      ta.textContent = safe;
      ta.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      setReactValue(ta, safe);
    }
  }

  async function fillDelivery(deliveryTime) {
    const input =
      inputAfterLabel(/how long will it take|delivery/i) || document.querySelector(S.deliveryInput);
    if (input && deliveryTime) setReactValue(input, deliveryTime);
  }

  async function runBidForm() {
    await humanDelay(900, 1700);
    const resp = await send({ type: "GET_PROPOSAL", slug });
    if (!resp || !resp.proposal) {
      await send({ type: "BID_DONE", slug, success: false, error: "No proposal available" });
      return;
    }
    const p = resp.proposal;

    await selectSkills(p.skills || []);
    await humanDelay();
    await selectProjects(p.projects || []);
    await humanDelay();
    await fillBudget(resp.price);
    await humanDelay();
    await fillProposal(p.proposalText || "");
    await humanDelay();
    await fillDelivery(p.deliveryTime);
    await humanDelay();

    if (resp.dryRun) {
      console.log("[Workana auto-bid] DRY RUN — form filled, not submitting.", { slug, price: resp.price });
      await send({ type: "BID_DONE", slug, success: true, dryRun: true });
      return;
    }

    const submitted = await clickByText(S.submitBidText, { timeout: 4000 });
    await sleep(1000); // let the submit register before moving to the next job

    // Optional visibility bump: a short follow-up question.
    if (submitted && resp.followUpQuestion) {
      await humanDelay(1500, 3000);
      // Implemented best-effort; safe to no-op if the UI differs.
      await clickByText(S.askQuestionText, { timeout: 2000 }).catch(() => {});
    }

    await send({ type: "BID_DONE", slug, success: submitted, error: submitted ? "" : "Submit button not found" });
  }

  if (!slug) return;
  (isBidForm ? runBidForm() : runDetail()).catch((e) =>
    send({ type: "BID_DONE", slug, success: false, error: String(e) })
  );
})();
