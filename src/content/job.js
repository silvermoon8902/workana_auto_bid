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

  const send = D.send; // safe sendMessage (no "context invalidated" throws)

  // Scroll the whole page top→bottom→top so the user can watch, and so Workana's
  // lazy-loaded sections (portfolio cards, insights, etc.) render before we read them.
  async function autoScroll() {
    try {
      const stepY = Math.max(300, Math.floor(window.innerHeight * 0.85));
      const maxY = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      for (let y = 0; y < maxY(); y += stepY) {
        window.scrollTo({ top: y, behavior: "smooth" });
        await sleep(220 + Math.random() * 200);
      }
      await sleep(300);
      window.scrollTo({ top: 0, behavior: "smooth" });
      await sleep(300);
    } catch {}
  }

  // Scroll an element into view and pause briefly (shows progress while filling).
  async function reveal(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(350);
    } catch {}
  }

  // ---------- shared scraping ----------
  function getBodyText() {
    return textOf(document.body);
  }

  // Map a flag CSS class (flag-br) to a country name.
  function countryFromFlag() {
    const el = document.querySelector(".wk-user-info .flag, .block-cta ~ article .flag, .flag");
    const m = el && el.className.match(/flag-([a-z]{2})/i);
    const code = m ? m[1].toLowerCase() : "";
    const map = {
      br: "Brazil", pt: "Portugal", ar: "Argentina", mx: "Mexico", co: "Colombia",
      cl: "Chile", pe: "Peru", es: "Spain", ve: "Venezuela", ec: "Ecuador", uy: "Uruguay",
      bo: "Bolivia", py: "Paraguay", gt: "Guatemala", do: "Dominican Republic", hn: "Honduras",
      sv: "El Salvador", ni: "Nicaragua", cr: "Costa Rica", pa: "Panama", cu: "Cuba",
      us: "United States", ua: "Ukraine", ph: "Philippines", in: "India",
      pk: "Pakistan", bd: "Bangladesh", ng: "Nigeria",
    };
    return map[code] || "";
  }

  function getDescription() {
    // The real description lives in the inline-expander block.
    const exp = document.querySelector(".block-detail .expander, .expander[inline-expander]");
    if (exp && textOf(exp).length > 60) return textOf(exp).slice(0, 4000);

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

  // Has a proposal already been sent for this job? (Restart-safety: avoids
  // re-bidding a job that was submitted but never got marked "bid" in storage.)
  function alreadySubmitted() {
    const body = getBodyText().toLowerCase();
    if (
      /você já enviou|ja enviou sua proposta|enviou uma proposta para este|ya enviaste|ya has enviado|you (already|have already) (sent|submitted)|already applied to this|your proposal has been sent/i.test(
        body
      )
    ) {
      return true;
    }
    // The "Place a bid" CTA turns into "Improve proposal" (edit/view) once you've bid.
    const cta = document.querySelector("#bid_button");
    const ctaText = cta ? textOf(cta).toLowerCase() : "";
    if (cta && /(improve|edit|editar|ver|view|mejorar|melhorar)\s+(proposal|proposta|propuesta|bid|oferta)/i.test(ctaText)) return true;
    return false;
  }

  function getClientPanel() {
    // Preferred: the structured .item-data blocks (number in <p class="h4">, label below).
    const items = qa(".item-data");
    let publishedCount = 0,
      paidCount = 0;
    for (const it of items) {
      const t = textOf(it);
      const n = Number(textOf(it.querySelector(".h4")) || (t.match(/\d+/) || [])[0] || 0);
      if (/Published projects/i.test(t)) publishedCount = n;
      else if (/Projects paid/i.test(t)) paidCount = n;
    }
    // Fallback to body-text parsing (bid page / other layouts).
    if (!publishedCount && !paidCount) {
      const body = getBodyText();
      const pick = (ps) => {
        for (const p of ps) {
          const m = body.match(p);
          if (m) return Number(m[1]);
        }
        return 0;
      };
      publishedCount = pick([/(\d+)\s*Published projects/i, /Published projects?\D{0,6}(\d+)/i, /Published:\s*(\d+)/i]);
      paidCount = pick([/(\d+)\s*Projects paid/i, /Projects paid\D{0,6}(\d+)/i, /Payments?:\s*(\d+)/i]);
    }

    const clientName =
      textOf(qa(".wk-user-info .user-name, [class*='client'] [class*='name'], [class*='author']")[0]) || "";
    const country =
      countryFromFlag() ||
      (getBodyText().match(
        /\b(Brazil|Brasil|Argentina|Mexico|México|Colombia|Chile|Peru|Perú|Spain|España|Venezuela|Ecuador|Uruguay|Bolivia|Paraguay|Portugal|United States|USA)\b/i
      ) || [])[0] ||
      "";

    // "Other projects posted by <client>" — used for the cross-language scam check.
    const priorPostingTitles = qa(".client-projects li a strong, .client-projects li strong")
      .map((e) => textOf(e))
      .filter(Boolean);

    return { publishedCount, paidCount, clientName, country, priorPostingTitles };
  }

  // Read the Insights "Average rate" from /job/insight/<slug> WITHOUT navigating.
  // (Clicking the "Project Insights" tab reloads this tab onto that route, which
  // corrupts the flow — so we fetch it same-origin instead.)
  async function fetchInsightAverage() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000); // never let this block the bid
      const res = await fetch(`https://www.workana.com/job/insight/${slug}`, {
        credentials: "include",
        signal: ctrl.signal,
      });
      clearTimeout(timer);
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
    await autoScroll(); // show activity + load lazy sections before scraping

    // Skip (and remember) jobs we've already bid on — don't waste a Claude call.
    if (alreadySubmitted()) {
      await send({ type: "ALREADY_BID", slug });
      return;
    }

    // Skip hourly jobs — only fixed-price fits the bid flow.
    const budgetText = textOf(document.querySelector("h4.budget, .budget"));
    if (/\/\s*hour\b|\/\s*hora\b|per hour|por hora|hourly/i.test(budgetText)) {
      await send({ type: "SKIP_JOB", slug, reason: "hourly" });
      return;
    }

    const description = getDescription();
    const client = getClientPanel();
    const avgPrice = await fetchInsightAverage();

    const resp = await send({
      type: "JOB_DETAIL",
      slug,
      data: { description, postingText: description, avgPrice, ...client },
    });

    if (!resp || resp.action === "skip" || resp.action === "abort") return; // background closes the tab

    // action === "bid" → open the bid form (direct link is most reliable).
    await humanDelay();
    const bidBtn =
      document.querySelector("#bid_button") || document.querySelector("a[href*='/messages/bid/']");
    if (bidBtn) {
      bidBtn.click();
    } else {
      const clicked = await clickByText(S.placeBidText, { timeout: 6000 });
      if (!clicked) await send({ type: "BID_DONE", slug, success: false, error: "Place-a-bid button not found" });
    }
    // Navigation to /messages/bid/<slug> triggers job.js again in bid-form mode.
  }

  // ---------- Phase B: bid form ----------
  // A chip is already selected if its label or its hidden checkbox says so.
  function chipSelected(chip) {
    if (chip.classList.contains("selected")) return true;
    const input = chip.querySelector("input");
    return !!input && (input.checked || input.classList.contains("selected"));
  }

  // Count the skills currently selected (chips shown in the .display-selector).
  function countSelectedSkills() {
    return qa(S.skillChip).filter((c) => c.offsetParent !== null && chipSelected(c)).length;
  }

  async function selectSkills(want = []) {
    const wants = want.map((w) => (w || "").toLowerCase().trim()).filter(Boolean);

    // Trim if Workana pre-selected MORE than 5 (over the "up to 5" limit).
    let selected = countSelectedSkills();
    if (selected > 5) {
      const ranked = qa(S.skillChip)
        .filter((c) => c.offsetParent !== null && chipSelected(c))
        .map((c) => ({ c, rel: wants.some((w) => textOf(c).toLowerCase().includes(w)) ? 1 : 0 }))
        .sort((a, b) => a.rel - b.rel); // least-relevant first
      for (const { c } of ranked) {
        if (countSelectedSkills() <= 5) break;
        c.click(); // deselect
        await sleep(150);
      }
      return countSelectedSkills();
    }
    if (selected >= 5) return selected;

    // Open the available-skills dropdown (profile skills offered for this project).
    const searchInput = document.querySelector(S.skillSearchInput);
    if (searchInput) {
      searchInput.focus();
      searchInput.click();
      await humanDelay(400, 800);
    }

    const RESULT_SEL = ".multi-select-results .multi-select-results-item, .multi-select-results-item, li[role='option']";

    // Click available skills (re-querying each time, since the list re-renders).
    // `predicate(label)` decides which items qualify; clicked items are remembered.
    async function pickAvailable(predicate) {
      const clicked = new Set();
      let guard = 0;
      while (countSelectedSkills() < 5 && guard++ < 15) {
        const items = qa(RESULT_SEL).filter((i) => i.offsetParent !== null && textOf(i).trim());
        const match = items.find((i) => {
          const t = textOf(i).toLowerCase();
          return !clicked.has(t) && predicate(t);
        });
        if (!match) break;
        clicked.add(textOf(match).toLowerCase());
        match.click();
        await humanDelay(350, 700);
      }
    }

    // 1) Relevant first (matching the job's skills), 2) then any to fill toward 5.
    await pickAvailable((label) => wants.some((w) => label.includes(w) || w.includes(label)));
    if (countSelectedSkills() < 5) await pickAvailable(() => true);

    // 3) Still under 5 → type each wanted skill to surface more profile skills.
    if (countSelectedSkills() < 5 && searchInput) {
      for (const w of wants) {
        if (countSelectedSkills() >= 5) break;
        setReactValue(searchInput, w);
        await humanDelay(500, 900);
        const opt = await waitForText(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), {
          selector: RESULT_SEL + ",label,div",
          timeout: 1500,
        });
        if (opt) {
          opt.click();
          await sleep(300);
        }
      }
    }
    return countSelectedSkills();
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

  // A card is selected when it has the `selected` class / the verified (check) icon.
  function cardSelected(card) {
    return card.classList.contains("selected") || !!card.querySelector(".wk2-icon-circle-verified");
  }

  // The cards to act on: the Search-portfolio modal's cards when it's open, else inline.
  function activeCardRoot() {
    const modal = qa(".modal-body, .modal-dialog, [role='dialog']").find(
      (m) => m.offsetParent !== null && m.querySelector(S.portfolioCard)
    );
    return modal || document;
  }

  // Select the best-matching UNSELECTED cards (never re-click a selected one — that
  // would deselect it). Counts the REAL selected state so 3 is 3.
  async function selectVisibleCards(titles, skills) {
    const root = activeCardRoot();
    const cards = qa(S.portfolioCard, root).filter((c) => c.offsetParent !== null);
    let selected = cards.filter(cardSelected).length;
    if (selected >= 3) return selected;

    const ranked = cards
      .filter((c) => !cardSelected(c))
      .map((c) => ({ c, ...scoreCard(c, titles, skills) }))
      .filter((x) => x.title && x.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const { c } of ranked) {
      if (selected >= 3) break;
      const sel = c.querySelector(S.portfolioSelect);
      if (sel) {
        sel.click();
        selected++;
        await sleep(400);
      }
    }
    return selected;
  }

  // Collect portfolio-card image URLs (the real project images on workana S3) —
  // selected cards first, then fill from the rest — for the follow-up message.
  function collectPortfolioImages(target) {
    const cards = qa(S.portfolioCard).filter((c) => c.offsetParent !== null);
    const ordered = [...cards.filter(cardSelected), ...cards.filter((c) => !cardSelected(c))];
    const urls = [];
    for (const c of ordered) {
      const img = c.querySelector(".wk-portfolio-card-img img, img");
      const src = img && img.src;
      if (src && /^https?:\/\//i.test(src) && !urls.includes(src)) urls.push(src);
      if (urls.length >= target) break;
    }
    return urls;
  }

  async function confirmModal() {
    // Click the footer "Add project" button (a.btn-success) — it confirms the
    // selection AND closes the modal. NOT the inline #portfolioOpenAddNew.
    const footer = qa(".modal-footer").find((f) => f.offsetParent !== null);
    if (!footer) return false;
    const btn =
      qa("a,button", footer).find((b) =>
        /add project|adicionar projeto|agregar proyecto|añadir proyecto/i.test(textOf(b))
      ) || footer.querySelector("a.btn-success, .btn-success");
    if (btn) {
      btn.click();
      await humanDelay(700, 1200);
      return true;
    }
    return false;
  }

  async function selectProjects(want) {
    const titles = (want.titles || []).map((s) => (s || "").toLowerCase().trim()).filter(Boolean);
    const skills = (want.skills || []).map((s) => (s || "").toLowerCase().trim()).filter(Boolean);
    if (!titles.length && !skills.length) return 0;

    // 1) Inline cards.
    let selected = await selectVisibleCards(titles, skills);

    // 2) Need more → open "Search portfolio", page "See more", select, then confirm.
    if (selected < 3) {
      const open =
        document.querySelector("#portfolioOpenBidDialog") ||
        (await waitForText(/search portfolio|buscar portfolio/i, { selector: "button,a", timeout: 1500 }));
      if (open) {
        open.click();
        await humanDelay(900, 1600);
        for (let i = 0; i < 6 && selected < 3; i++) {
          selected = await selectVisibleCards(titles, skills);
          if (selected >= 3) break;
          const more = await waitForText(/see more|ver más|ver mais/i, { selector: "button,a,.btn", timeout: 1500 });
          if (!more) break;
          more.click();
          await humanDelay(900, 1600);
        }
        // Confirm + close the modal (the "Add project" button appears once picks exist).
        await confirmModal();
      }
    }
    return selected;
  }

  async function fillBudget(price) {
    // #Amount = Total rate (NOT #Hours). Putting the bid in Hours makes Workana
    // auto-inflate the total.
    const input =
      document.querySelector(S.totalRateInput) || inputAfterLabel(/total rate/i) || (await waitForSelector(S.totalRateInput, { timeout: 4000 }));
    if (!input) return;
    await reveal(input);
    let val = Math.round(Number(price) || 0);
    const min = readMinBid();
    if (min && val < min) val = Math.ceil(min); // respect the form's minimum bid
    if (val > 0) setReactValue(input, String(val));
  }

  async function fillProposal(text) {
    const ta =
      document.querySelector(S.proposalTextarea) || inputAfterLabel(/proposal details/i) || (await waitForSelector(S.proposalTextarea, { timeout: 4000 }));
    if (!ta || !text) return;
    await reveal(ta);
    // Drop any budget/timeline footer lines that contradict the real fields.
    const stripped = String(text)
      .split("\n")
      .filter((l) => !/total\s*budget|presupuesto\s*total|or[çc]amento\s*total|timeline\s*:|^\s*[💰⏳⌛]/i.test(l))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    // Defuse Workana's link/contact filter so the bid isn't blocked/suspended.
    const safe = sanitizeOutgoing(stripped);
    if (ta.isContentEditable) {
      ta.focus();
      ta.textContent = safe;
      ta.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      setReactValue(ta, safe);
    }
  }

  function dataUrlToFile(dataUrl, filename) {
    const [meta, b64] = dataUrl.split(",");
    const mime = (meta.match(/data:(.*?);/) || [, "image/png"])[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], filename, { type: mime });
  }

  // Ask the background to screenshot the portfolio URLs, then upload each image
  // into the bid form's file input (#AttachmentUpload).
  async function attachScreenshots(urls, max) {
    const list = (urls || []).filter(Boolean).slice(0, max || 2);
    if (!list.length) return 0;
    const input = document.querySelector("#AttachmentUpload, input[type='file'][name='message.attachments'], input[type='file']");
    if (!input) return 0;

    const resp = await send({ type: "CAPTURE", urls: list });
    const shots = (resp && resp.shots) || [];
    let n = 0;
    for (const shot of shots) {
      try {
        const file = dataUrlToFile(shot.dataUrl, shot.filename || `portfolio-${n + 1}.png`);
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        n++;
        await humanDelay(1800, 2800); // let the inline upload finish before the next
      } catch (e) {
        console.warn("[WK job] attach failed", e);
      }
    }
    return n;
  }

  async function fillDelivery(deliveryTime) {
    const input =
      document.querySelector(S.deliveryInput) || inputAfterLabel(/how long will it take|delivery/i);
    if (input && deliveryTime) {
      await reveal(input);
      setReactValue(input, deliveryTime);
    }
  }

  async function runBidForm() {
    // Hard guard: never let the bid phase hang silently to the 180s watchdog.
    const guard = sleep(80000).then(() => "TIMEOUT");
    const outcome = await Promise.race([_runBidForm(), guard]);
    if (outcome === "TIMEOUT") {
      await send({ type: "BID_DONE", slug, success: false, error: "Bid form timed out" });
    }
  }

  async function _runBidForm() {
    await humanDelay(900, 1700);
    await autoScroll(); // render the portfolio cards / budget / proposal sections

    // If Workana shows we've already bid (no form / "already sent"), skip.
    if (alreadySubmitted()) {
      await send({ type: "ALREADY_BID", slug });
      return;
    }

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

    // Stash the highlighted projects' images for the post-bid follow-up message.
    try {
      const imgs = collectPortfolioImages(Math.max(4, resp.maxAttachments || 4));
      if (imgs.length) await send({ type: "SET_FOLLOWUP_IMAGES", slug, images: imgs });
    } catch {}
    await fillBudget(resp.price);
    await humanDelay();
    await fillProposal(p.proposalText || "");
    await humanDelay();
    await fillDelivery(p.deliveryTime);
    await humanDelay();

    if (resp.attachScreenshots) {
      await attachScreenshots(p.attachments || [], resp.maxAttachments);
      await humanDelay();
    }

    if (resp.dryRun) {
      console.log("[Workana auto-bid] DRY RUN — form filled, not submitting.", { slug, price: resp.price });
      await send({ type: "BID_DONE", slug, success: true, dryRun: true });
      return;
    }

    // Submit is an <input type=submit> (no text) — click by selector, not text.
    const submitEl =
      (await waitForSelector(S.submitButton, { timeout: 4000 })) ||
      (await waitForText(S.submitBidText, { selector: "button,a", timeout: 1000 }));
    if (!submitEl) {
      await send({ type: "BID_DONE", slug, success: false, error: "Submit button not found" });
      return;
    }
    await reveal(submitEl);
    submitEl.click();
    // Detect the outcome OURSELVES — Workana submits either via a full redirect to
    // /inbox OR via an in-app (SPA) route change; both LEAVE the bid form. Poll for
    // either (a) the path no longer being /messages/bid, or (b) a success message.
    // If a full navigation destroys this script first, the background's onUpdated
    // handler resolves it instead (resolveBid is idempotent).
    let resolved = false;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      if (!/\/messages\/bid\//i.test(location.pathname)) {
        await send({ type: "BID_DONE", slug, success: true });
        resolved = true;
        break;
      }
      if (/sent successfully|enviada con [eé]xito|enviada com sucesso|proposta enviada|propuesta enviada/i.test(textOf(document.body))) {
        await send({ type: "BID_DONE", slug, success: true });
        resolved = true;
        break;
      }
    }
    if (!resolved) {
      await send({ type: "BID_DONE", slug, success: false, error: "Submit did not complete (validation error?)" });
    }
  }

  if (!slug) return;
  (isBidForm ? runBidForm() : runDetail()).catch((e) =>
    send({ type: "BID_DONE", slug, success: false, error: String(e) })
  );
})();
