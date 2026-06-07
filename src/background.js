// background.js — orchestrator + job state machine + Claude calls.
import {
  getConfig,
  setConfig,
  getState,
  setState,
  markJob,
  isHandled,
  addScammer,
  saveProposal,
  getProposal,
  saveThread,
  canBidNow,
  recordBid,
} from "./lib/storage.js";
import { generateProposal, generateReply, detectLanguage } from "./lib/claude.js";
import { assessClient, guessLanguage, isSpanishOrPortugueseCountry } from "./lib/scammer.js";

const ALARM = "workana-poll";

// In-memory runtime state (rebuilt from storage on wake).
const rt = {
  searchTabId: null,
  jobTabId: null, // the single in-flight bid tab
  inFlightSlug: null,
  queue: [], // slugs pending
};

// ---------------- lifecycle ----------------
chrome.runtime.onInstalled.addListener(refreshAlarm);
chrome.runtime.onStartup.addListener(refreshAlarm);

async function refreshAlarm() {
  const cfg = await getConfig();
  await chrome.alarms.clear(ALARM);
  if (cfg.enabled) {
    chrome.alarms.create(ALARM, { periodInMinutes: Math.max(0.5, cfg.pollMinutes || 1) });
    await setBadge(true);
    poll();
  } else {
    await setBadge(false);
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) poll();
});

async function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: on ? "#16a34a" : "#9ca3af" });
}

// Show an in-page toast on the persistent search tab (or any open Workana tab),
// so outcomes are visible even after the job tab that produced them has closed.
async function notify(level, text) {
  const payload = { type: "TOAST", level, text };
  try {
    if (rt.searchTabId != null) {
      try {
        await chrome.tabs.sendMessage(rt.searchTabId, payload);
        return;
      } catch {}
    }
    const tabs = await chrome.tabs.query({ url: "*://*.workana.com/*" });
    const target = tabs.find((t) => /\/jobs/.test(t.url || "")) || tabs[0];
    if (target) await chrome.tabs.sendMessage(target.id, payload).catch(() => {});
  } catch {}
}

// Clear in-flight if its tab is closed out from under us.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === rt.jobTabId) {
    rt.jobTabId = null;
    rt.inFlightSlug = null;
    pump();
  }
  if (tabId === rt.searchTabId) rt.searchTabId = null;
});

// ---------------- polling: ensure the search tab is loaded ----------------
async function poll() {
  const cfg = await getConfig();
  if (!cfg.enabled || !cfg.searchUrl) return;
  try {
    if (rt.searchTabId !== null) {
      await chrome.tabs.reload(rt.searchTabId);
    } else {
      const tab = await chrome.tabs.create({ url: cfg.searchUrl, active: false });
      rt.searchTabId = tab.id;
    }
  } catch {
    const tab = await chrome.tabs.create({ url: cfg.searchUrl, active: false });
    rt.searchTabId = tab.id;
  }
}

// ---------------- pump: open the next queued job ----------------
async function pump() {
  const cfg = await getConfig();
  if (!cfg.enabled) return;
  if (rt.jobTabId !== null) return; // one bid at a time
  if (!(await canBidNow(cfg))) return; // hourly cap reached

  let slug;
  while ((slug = rt.queue.shift())) {
    if (!(await isHandled(slug))) break;
    slug = null;
  }
  if (!slug) return;

  rt.inFlightSlug = slug;
  await markJob(slug, "scanned");
  console.debug("[WK bg] opening job tab:", slug);
  try {
    const tab = await chrome.tabs.create({
      url: `https://www.workana.com/job/${slug}`,
      active: false,
    });
    rt.jobTabId = tab.id;
  } catch (e) {
    rt.jobTabId = null;
    rt.inFlightSlug = null;
    await markJob(slug, "error", { error: String(e) });
  }
}

function finishInFlight() {
  if (rt.jobTabId !== null) chrome.tabs.remove(rt.jobTabId).catch(() => {});
  rt.jobTabId = null;
  rt.inFlightSlug = null;
  setTimeout(pump, 1200);
}

// ---------------- pricing ----------------
function parseRange(budgetStr) {
  const nums = (budgetStr || "").replace(/[.,](?=\d{3}\b)/g, "").match(/\d+/g);
  if (!nums) return { low: null, high: null };
  const v = nums.map(Number).filter((n) => n > 0);
  if (!v.length) return { low: null, high: null };
  return v.length >= 2 ? { low: v[0], high: v[1] } : { low: v[0], high: v[0] };
}

function computePrice(cfg, { avgPrice, budget }) {
  const { low, high } = parseRange(budget);

  // Trust the scraped Insights average only if it's sane vs. the posted budget;
  // a mis-parse (e.g. 17000 on a 1k–3k job) would otherwise blow up the bid.
  let avg = avgPrice;
  if (avg && high && (avg > high * 3 || avg < (low || high) * 0.3)) avg = null;

  // Reference: sane average, else midpoint of the budget.
  let ref = avg || (low && high ? (low + high) / 2 : low || high);

  // Tier override (range → fixed bid).
  if (ref != null) {
    const tier = (cfg.priceStrategy || []).find((t) => ref >= t.min && ref <= t.max);
    if (tier) ref = tier.bid;
  }

  // Underbid the reference by the configured percentage.
  let price = ref != null ? ref * (1 - (cfg.underbidPct || 15) / 100) : (cfg.priceStrategy?.[0]?.bid || 0);

  // Clamp into the posted budget range so we never bid absurd amounts.
  if (high) price = Math.min(price, high);
  if (low) price = Math.max(price, low);

  return Math.max(0, Math.round(price / 10) * 10);
}

// ---------------- message bus ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
  return true; // async
});

async function handle(msg, sender) {
  const cfg = await getConfig();
  switch (msg.type) {
    // ---- popup/options control ----
    case "GET_STATUS": {
      const [processed, scammerList] = [await getState("processedJobs"), await getState("scammerList")];
      const stats = await getState("stats");
      return {
        config: cfg,
        queue: rt.queue.length,
        inFlight: rt.inFlightSlug,
        scammerCount: scammerList.length,
        scammerList: scammerList.slice(0, 25),
        processedCount: Object.keys(processed).length,
        bidsThisHour: stats.bidsThisHour,
      };
    }
    case "SET_ENABLED": {
      await setConfig({ enabled: !!msg.enabled });
      await refreshAlarm();
      if (msg.enabled) {
        // Immediately re-scan any jobs tabs already open (Start pressed after load).
        try {
          const tabs = await chrome.tabs.query({ url: "*://*.workana.com/jobs*" });
          for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "RESCAN" }).catch(() => {});
        } catch {}
        pump();
      }
      return { ok: true, enabled: !!msg.enabled };
    }

    // ---- auto-bid flow ----
    case "JOBS_FOUND": {
      if (!cfg.enabled) return { ok: false };
      let queued = 0,
        preskipped = 0;
      for (const job of msg.jobs || []) {
        if (await isHandled(job.slug)) continue;
        if (rt.queue.includes(job.slug) || rt.inFlightSlug === job.slug) continue;

        // Cheap pre-skip using the data already on the search card (avoids
        // opening a tab for obvious non-payers). Full check still runs on the job page.
        const postingLang = guessLanguage(job.snippet || "");
        const verdict = assessClient({
          clientName: job.clientName,
          country: job.country,
          publishedCount: job.publishedCount,
          paidCount: job.paidCount,
          postingText: job.snippet,
          postingLang,
        });
        if (verdict.flagged) {
          await addScammer({ clientName: job.clientName || job.slug, slug: job.slug, reasons: verdict.reasons });
          await markJob(job.slug, "skipped-scammer", { reasons: verdict.reasons, title: job.title });
          notify("warn", `🚩 Scammer skipped: ${job.clientName || job.title || job.slug} — ${verdict.reasons[0]}`);
          preskipped++;
          continue;
        }

        rt.queue.push(job.slug);
        const meta = await getState("processedJobs");
        if (!meta[job.slug]) {
          meta[job.slug] = { status: "queued", ts: Date.now(), budget: job.budget, country: job.country, title: job.title };
          await setState("processedJobs", meta);
        }
        queued++;
      }
      console.debug(
        "[WK bg] JOBS_FOUND in=%d queued+=%d preskip=%d total=%d",
        (msg.jobs || []).length, queued, preskipped, rt.queue.length
      );
      pump();
      return { ok: true, queued: rt.queue.length };
    }

    case "JOB_DETAIL": {
      const { slug, data } = msg;
      // Language of the posting (cheap guess; Claude fallback if unknown).
      let postingLang = guessLanguage(data.postingText);
      if (postingLang === "unknown" && isSpanishOrPortugueseCountry(data.country)) {
        try {
          postingLang = await detectLanguage(cfg, data.postingText);
        } catch {}
      }
      // Languages of the client's OTHER postings — a PT/ES client with an
      // English posting is the fake-review scam pattern.
      const priorPostingLangs = (data.priorPostingTitles || [])
        .map((t) => guessLanguage(t))
        .filter((l) => l && l !== "unknown");

      const verdict = assessClient({
        clientName: data.clientName,
        country: data.country,
        publishedCount: data.publishedCount,
        paidCount: data.paidCount,
        postingText: data.postingText,
        postingLang,
        priorPostingLangs,
      });
      if (verdict.flagged) {
        await addScammer({ clientName: data.clientName || slug, slug, reasons: verdict.reasons });
        await markJob(slug, "skipped-scammer", { reasons: verdict.reasons });
        notify("warn", `🚩 Flagged: ${data.clientName || slug} — ${verdict.reasons[0]}`);
        finishInFlight();
        return { action: "skip", reasons: verdict.reasons };
      }

      // Generate the proposal now and stash it for the bid-form phase.
      try {
        const proposal = await generateProposal(cfg, {
          description: data.description,
          clientName: data.clientName,
          country: data.country,
        });
        const procMeta = (await getState("processedJobs"))[slug] || {};
        const price = computePrice(cfg, { avgPrice: data.avgPrice, budget: procMeta.budget });
        await saveProposal(slug, {
          title: data.description.slice(0, 80),
          description: data.description,
          proposal: proposal.proposalText,
          price,
          skills: proposal.skills,
          projects: proposal.projects,
          deliveryTime: proposal.deliveryTime,
          attachments: proposal.attachments,
          _full: proposal,
        });
        return { action: "bid" };
      } catch (e) {
        // Transient Claude failure (rate limit / overload / parse): retry the job
        // once on a later pump instead of permanently abandoning + closing it.
        console.error("[WK bg] proposal generation failed for", slug, e);
        const processed = await getState("processedJobs");
        const m = processed[slug] || {};
        const attempts = (m.attempts || 0) + 1;
        processed[slug] = {
          ...m,
          status: attempts < 2 ? "queued" : "error",
          attempts,
          error: String(e),
          ts: Date.now(),
        };
        await setState("processedJobs", processed);
        if (attempts < 2) rt.queue.push(slug);
        notify(
          attempts < 2 ? "warn" : "error",
          `${attempts < 2 ? "↻ Proposal failed, will retry" : "⚠️ Proposal failed"}: ${m.title || slug}`
        );
        finishInFlight();
        return { action: "abort", error: String(e) };
      }
    }

    case "GET_PROPOSAL": {
      const saved = await getProposal(msg.slug);
      if (!saved) return { proposal: null };
      return {
        proposal: saved._full || {
          proposalText: saved.proposal,
          skills: saved.skills,
          projects: saved.projects,
          deliveryTime: saved.deliveryTime,
          attachments: saved.attachments || [],
        },
        price: saved.price,
        dryRun: cfg.dryRun,
        followUpQuestion: cfg.followUpQuestion,
      };
    }

    case "BID_DONE": {
      const { slug, success, error, dryRun } = msg;
      const saved = await getProposal(slug);
      const proc = (await getState("processedJobs"))[slug] || {};
      const label = proc.title || (saved && saved.title) || slug;
      await markJob(slug, success ? "bid" : "error", { error: error || "", dryRun: !!dryRun, title: proc.title });
      if (success && !dryRun) await recordBid();
      if (success && dryRun) notify("info", `📝 Dry-run filled: ${label}${saved ? ` ($${saved.price})` : ""}`);
      else if (success) notify("success", `✅ Bid submitted: ${label}${saved ? ` ($${saved.price})` : ""}`);
      else notify("error", `⚠️ Bid failed: ${label}${error ? ` — ${error}` : ""}`);
      finishInFlight();
      return { ok: true };
    }

    // ---- auto-reply flow ----
    case "MESSAGES_ENABLED":
      return { enabled: cfg.enabled, dryRun: cfg.dryRun };

    case "CHAT_REPLY": {
      if (!cfg.enabled) return { skip: true };
      // Match the saved proposal by fuzzy job-title overlap.
      const proposals = await getState("proposals");
      const title = (msg.jobTitle || "").toLowerCase();
      let match = null;
      for (const [slug, p] of Object.entries(proposals)) {
        const t = (p.title || "").toLowerCase();
        if (t && (title.includes(t.slice(0, 30)) || t.includes(title.slice(0, 30)))) {
          match = { slug, ...p };
          break;
        }
      }
      try {
        const out = await generateReply(cfg, {
          jobPosting: match?.description || msg.jobTitle,
          sentProposal: match?.proposal || "",
          chatHistory: msg.chatHistory,
          newMessage: msg.newMessage,
        });
        await saveThread(msg.threadId, {
          jobSlug: match?.slug || null,
          history: msg.chatHistory,
          lastRepliedTs: out.shouldEscalate ? 0 : Date.now(),
        });
        if (out.shouldEscalate) notify("warn", `💬 Needs human reply: ${msg.jobTitle || msg.threadId}`);
        return { replyText: out.replyText, shouldEscalate: out.shouldEscalate, dryRun: cfg.dryRun };
      } catch (e) {
        return { skip: true, error: String(e) };
      }
    }

    case "CHAT_SENT":
      await saveThread(msg.threadId, { lastRepliedTs: Date.now() });
      notify("success", `💬 Replied to client (${msg.threadId})`);
      return { ok: true };

    default:
      return { ok: false, unknown: msg.type };
  }
}
