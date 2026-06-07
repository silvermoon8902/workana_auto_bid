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
      us: "United States",
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

  async function selectSkills(want = []) {
    const wants = want.map((w) => (w || "").toLowerCase().trim()).filter(Boolean);
    const chips = qa(S.skillChip).filter((c) => c.offsetParent !== null);

    // Workana pre-selects the direct matches. Count them.
    let selected = chips.filter(chipSelected).length;

    // If MORE than 5 are pre-selected (over the "up to 5" limit), trim the
    // least-relevant extras so the form is valid for submit.
    if (selected > 5) {
      const ranked = chips
        .filter(chipSelected)
        .map((c) => ({ c, rel: wants.some((w) => textOf(c).toLowerCase().includes(w)) ? 1 : 0 }))
        .sort((a, b) => a.rel - b.rel); // least-relevant first
      for (const { c } of ranked) {
        if (selected <= 5) break;
        c.click(); // deselect
        selected--;
        await sleep(150);
      }
      return selected;
    }
    if (selected >= 5) return selected;

    // 1) Top up with UNSELECTED chips matching Claude's suggested skills
    //    (never click a selected chip — that would deselect it).
    for (const chip of chips) {
      if (selected >= 5) break;
      if (chipSelected(chip)) continue;
      const label = textOf(chip).toLowerCase();
      if (wants.some((w) => label.includes(w) || w.includes(label))) {
        chip.click();
        selected++;
        await sleep(200);
      }
    }

    // 1b) Still under 5 → fill with any remaining unselected chips (reach 5).
    if (selected < 5) {
      for (const chip of chips) {
        if (selected >= 5) break;
        if (chipSelected(chip)) continue;
        chip.click();
        selected++;
        await sleep(200);
      }
    }

    // 2) Still under 5 (not enough chips) → use the "Search skills" box to add more.
    if (selected < 5) {
      const input = document.querySelector(S.skillSearchInput);
      if (input) {
        for (const w of wants) {
          if (selected >= 5) break;
          setReactValue(input, w);
          await humanDelay(500, 900);
          const opt = await waitForText(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), {
            selector: "li,[role='option'],label,div",
            timeout: 1500,
          });
          if (opt) {
            opt.click();
            selected++;
            await sleep(200);
          }
        }
      }
    }
    return selected;
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
        // Confirm the modal selection with its footer "Add project" button
        // (a.btn-success in .modal-footer) — NOT the inline #portfolioOpenAddNew.
        const modal = document.querySelector(".modal-dialog, [role='dialog'], .modal, .wk-modal, .modal-content");
        if (modal) {
          const footer = modal.querySelector(".modal-footer") || modal;
          const btn =
            footer.querySelector("a.btn-success, .btn-success") ||
            qa("a,button", footer).find((b) =>
              /add project|adicionar projeto|agregar proyecto|añadir proyecto|confirmar|^done$|^listo$/i.test(textOf(b))
            );
          if (btn) {
            btn.click();
            await humanDelay(700, 1200);
          }
        }
      }
    }
    return picked.size;
  }

  async function fillBudget(price) {
    // #Amount = Total rate (NOT #Hours). Putting the bid in Hours makes Workana
    // auto-inflate the total.
    const input =
      document.querySelector(S.totalRateInput) || inputAfterLabel(/total rate/i) || (await waitForSelector(S.totalRateInput, { timeout: 4000 }));
    if (!input) return;
    let val = Math.round(Number(price) || 0);
    const min = readMinBid();
    if (min && val < min) val = Math.ceil(min); // respect the form's minimum bid
    if (val > 0) setReactValue(input, String(val));
  }

  async function fillProposal(text) {
    const ta =
      document.querySelector(S.proposalTextarea) || inputAfterLabel(/proposal details/i) || (await waitForSelector(S.proposalTextarea, { timeout: 4000 }));
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
    let submitted = false;
    if (submitEl) {
      submitEl.click();
      submitted = true;
    }
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
