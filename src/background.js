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
function parseBudgetMidpoint(budgetStr) {
  const nums = (budgetStr || "").replace(/[.,](?=\d{3}\b)/g, "").match(/\d+/g);
  if (!nums) return null;
  const vals = nums.map(Number);
  return vals.length >= 2 ? (vals[0] + vals[1]) / 2 : vals[0];
}

function computePrice(cfg, { avgPrice, budget }) {
  const ref = avgPrice || parseBudgetMidpoint(budget);
  let base = null;
  if (ref != null) {
    const tier = (cfg.priceStrategy || []).find((t) => ref >= t.min && ref <= t.max);
    if (tier) base = tier.bid;
  }
  if (base == null) base = ref; // no tier → use the reference
  // Cap to underbid the average.
  if (avgPrice) {
    const cap = avgPrice * (1 - (cfg.underbidPct || 15) / 100);
    base = base == null ? cap : Math.min(base, cap);
  }
  if (base == null) base = (cfg.priceStrategy?.[0]?.bid) || 0;
  return Math.max(0, Math.round(base / 10) * 10);
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
      if (msg.enabled) pump();
      return { ok: true, enabled: !!msg.enabled };
    }

    // ---- auto-bid flow ----
    case "JOBS_FOUND": {
      if (!cfg.enabled) return { ok: false };
      for (const job of msg.jobs || []) {
        if (await isHandled(job.slug)) continue;
        if (rt.queue.includes(job.slug)) continue;
        if (rt.inFlightSlug === job.slug) continue;
        rt.queue.push(job.slug);
        // Keep the search-scraped meta for pricing fallback.
        const meta = await getState("processedJobs");
        if (!meta[job.slug]) {
          meta[job.slug] = { status: "queued", ts: Date.now(), budget: job.budget, country: job.country };
          await setState("processedJobs", meta);
        }
      }
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
      const verdict = assessClient({
        clientName: data.clientName,
        country: data.country,
        publishedCount: data.publishedCount,
        paidCount: data.paidCount,
        postingText: data.postingText,
        postingLang,
      });
      if (verdict.flagged) {
        await addScammer({ clientName: data.clientName || slug, slug, reasons: verdict.reasons });
        await markJob(slug, "skipped-scammer", { reasons: verdict.reasons });
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
        await markJob(slug, "error", { error: String(e) });
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
      await markJob(slug, success ? "bid" : "error", { error: error || "", dryRun: !!dryRun });
      if (success && !dryRun) await recordBid();
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
        return { replyText: out.replyText, shouldEscalate: out.shouldEscalate, dryRun: cfg.dryRun };
      } catch (e) {
        return { skip: true, error: String(e) };
      }
    }

    case "CHAT_SENT":
      await saveThread(msg.threadId, { lastRepliedTs: Date.now() });
      return { ok: true };

    default:
      return { ok: false, unknown: msg.type };
  }
}
