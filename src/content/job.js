// job.js — runs on /job/<slug> (detail) AND /messages/bid/<slug> (bid form).
// Phase is decided by URL. Coordinates with the background state machine.

(function () {
  const D = window.WKDom;
  const { textOf, qa, slugFromUrl, waitForSelector, waitForText, clickByText, setReactValue, humanDelay, sleep, inputAfterLabel, readMinBid, sanitizeOutgoing, S } = D;

  // The "Project Insights" tab lives at /job/insight/<slug> — never act there
  // (navigating to it would re-run this script with a corrupt slug).
  if (/\/job\/insight\//i.test(location.pathname)) return;

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

  // Read the Insights "Average rate" from /job/insight/<slug> WITHOUT navigating.
  // (Clicking the "Project Insights" tab reloads this tab onto that route, which
  // corrupts the flow — so we fetch it same-origin instead.)
  async function fetchInsightAverage() {
    try {
      const res = await fetch(`https://www.workana.com/job/insight/${slug}`, { credentials: "include" });
      if (!res.ok) return null;
      const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const m =
        text.match(/USD?\s*\$?\s*([\d.,]+)\s*Average rate/i) ||
        text.match(/Average rate\D{0,12}USD?\s*\$?\s*([\d.,]+)/i);
      const avg = m ? Number(m[1].replace(/[.,](?=\d{3}\b)/g, "")) : null;
      console.debug("[WK job] insight average:", avg, "for", slug);
      return avg;
    } catch {
      return null;
    }
  }

  // ---------- Phase A: job detail ----------
  async function runDetail() {
    await humanDelay(900, 1700);
    const description = getDescription();
    const client = getClientPanel();
    const avgPrice = await fetchInsightAverage();

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

  // Score a portfolio card by title match + skill overlap with the proposal.
  function scoreCard(card, titles, skills) {
    const title = textOf(card.querySelector(S.portfolioTitle)).toLowerCase();
    if (!title) return { title: "", score: -1 };
    const cardSkills = qa(S.portfolioSkill, card).map((s) => textOf(s).toLowerCase());
    let score = 0;
    if (titles.some((t) => t && (title.includes(t) || t.includes(title)))) score += 5;
    score += cardSkills.filter((cs) => skills.some((s) => s && (cs.includes(s) || s.includes(cs)))).length;
    return { title, score };
  }

  // Click the SELECT (circle-plus) label on the best-matching visible cards.
  async function selectVisibleCards(titles, skills, picked) {
    const ranked = qa(S.portfolioCard)
      .filter((c) => c.offsetParent !== null)
      .map((c) => ({ c, ...scoreCard(c, titles, skills) }))
      .filter((x) => x.title && !picked.has(x.title) && x.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const { c, title } of ranked) {
      if (picked.size >= 3) break;
      const sel = c.querySelector(S.portfolioSelect);
      if (sel) {
        sel.click();
        picked.add(title);
        await sleep(300);
      }
    }
  }

  async function selectProjects(want) {
    const titles = (want.titles || []).map((s) => (s || "").toLowerCase().trim()).filter(Boolean);
    const skills = (want.skills || []).map((s) => (s || "").toLowerCase().trim()).filter(Boolean);
    if (!titles.length && !skills.length) return 0;
    const picked = new Set();

    // 1) Pick from the inline cards.
    await selectVisibleCards(titles, skills, picked);

    // 2) Still need more relevant ones → open "Search portfolio" and page through.
    if (picked.size < 3) {
      const open =
        document.querySelector("#portfolioOpenBidDialog") ||
        (await waitForText(/search portfolio|buscar portfolio/i, { selector: "button,a", timeout: 1500 }));
      if (open) {
        open.click();
        await humanDelay(900, 1600);
        for (let i = 0; i < 4 && picked.size < 3; i++) {
          await selectVisibleCards(titles, skills, picked);
          if (picked.size >= 3) break;
          const more = await waitForText(/see more|ver más|ver mais/i, { selector: "button,a", timeout: 1500 });
          if (!more) break;
          more.click();
          await humanDelay(900, 1600);
        }
        // Confirm inside the dialog if it has a confirm button (scoped to the modal).
        const modal = document.querySelector("[role='dialog'], .modal, .wk-modal, .modal-dialog");
        if (modal) {
          const btn = qa("button,a", modal).find((b) =>
            /^(select|add|confirm|done|choose|seleccionar|adicionar|confirmar|listo)$/i.test(textOf(b))
          );
          if (btn) btn.click();
        }
      }
    }
    return picked.size;
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
    await selectProjects({ titles: p.projects || [], skills: p.skills || [] });
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
