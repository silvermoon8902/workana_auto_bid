// storage.js — typed-ish helpers over chrome.storage.local for config + runtime state.
// Imported by the background service worker (ES module).

export const DEFAULT_CONFIG = {
  apiKey: "",
  model: "claude-opus-4-8",
  profile: "",
  ranking: "", // e.g. "Gold (global rank #1234)"
  projects: [], // [{ title, summary, link }]
  searchUrl: "", // saved-search jobs URL
  proposalPrompt:
    "Write a concise, confident first-person proposal in the SAME language as the project description. " +
    "Open by addressing the client's specific problem, show one concrete relevant result from my past projects, " +
    "state a clear next step. Avoid generic filler. Never include external contact info.",
  replyRules:
    "Reply in the same language and tone as the client. Be helpful and move the deal forward. " +
    "Never share off-platform contact details (email/phone/WhatsApp) — Workana penalizes it. " +
    "If the client asks to move off-platform or the message needs a human decision, set shouldEscalate=true and do not send.",
  priceStrategy: [
    { min: 250, max: 500, bid: 500 },
    { min: 500, max: 1000, bid: 700 },
  ],
  underbidPct: 15, // bid this % below the Insights average
  pollMinutes: 1,
  maxBidsPerHour: 10,
  enabled: false, // master Start/Pause flag
  dryRun: false, // when true: fill the form but do NOT submit
  followUpQuestion: true, // send a short question after bidding to bump visibility
  attachScreenshots: true, // screenshot portfolio URLs Claude returns and attach them
  maxAttachments: 2, // cap how many screenshots to capture/attach per bid
  focusTabs: true, // open each job tab focused + scroll it (watch the automation)
  blockedCountries: "Ukraine, Philippines", // skip clients from these countries (comma-separated)
  sendFollowUp: true, // after a bid, post a short follow-up message in the /inbox thread
  followUpPrompt:
    "Send a short, warm follow-up that offers to share relevant work samples and asks one quick engaging question.",
};

const STATE_KEYS = {
  processedJobs: {}, // { [slug]: { status, ts, price } }
  scammerList: [], // [{ clientName, slug, reasons[], ts }]
  proposals: {}, // { [slug]: { title, description, proposal, price, skills, projects, ts } }
  threads: {}, // { [threadId]: { jobSlug, history[], lastRepliedTs } }
  stats: { bidsThisHour: 0, hourStart: 0 },
  recentEvents: [], // [{ level, text, ts }] — activity log shown in the popup
};

export async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

export async function setConfig(patch) {
  const current = await getConfig();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ config: next });
  return next;
}

export async function getState(key) {
  const res = await chrome.storage.local.get(key);
  return res[key] !== undefined ? res[key] : structuredClone(STATE_KEYS[key]);
}

export async function setState(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// --- processedJobs helpers ---
export async function getProcessed() {
  return getState("processedJobs");
}
export async function markJob(slug, status, extra = {}) {
  const processed = await getProcessed();
  processed[slug] = { status, ts: Date.now(), ...extra };
  await setState("processedJobs", processed);
}
export async function isHandled(slug) {
  const processed = await getProcessed();
  const rec = processed[slug];
  // "scanned" is a transient in-flight marker; treat bid/skipped/error as done.
  return rec && ["bid", "skipped-scammer", "skipped", "error"].includes(rec.status);
}

// --- scammer list ---
export async function addScammer(entry) {
  const list = await getState("scammerList");
  list.unshift({ ...entry, ts: Date.now() });
  await setState("scammerList", list.slice(0, 500));
}

// --- proposals ---
export async function saveProposal(slug, data) {
  const proposals = await getState("proposals");
  proposals[slug] = { ...data, ts: Date.now() };
  await setState("proposals", proposals);
}
export async function getProposal(slug) {
  const proposals = await getState("proposals");
  return proposals[slug];
}

// --- threads (auto-reply memory) ---
export async function saveThread(threadId, data) {
  const threads = await getState("threads");
  threads[threadId] = { ...(threads[threadId] || {}), ...data };
  await setState("threads", threads);
}

// --- bid rate limiting ---
export async function canBidNow(config) {
  const stats = await getState("stats");
  const now = Date.now();
  if (now - stats.hourStart > 3600_000) {
    stats.hourStart = now;
    stats.bidsThisHour = 0;
  }
  await setState("stats", stats);
  return stats.bidsThisHour < config.maxBidsPerHour;
}
export async function recordBid() {
  const stats = await getState("stats");
  stats.bidsThisHour += 1;
  await setState("stats", stats);
}
