# Workana Auto-Bid & Auto-Reply (Chrome extension, MV3)

Fully-automatic Workana assistant:

1. **Auto-bid** — refreshes your saved job search every minute, opens each new job, reads the **Project Insights** average price and the client panel, runs a **scam check**, generates a tailored proposal with Claude, fills the bid form (skills ≤5, portfolio projects ≤3, budget, proposal, delivery), and submits.
2. **Auto-reply** — when a client replies in `/messages`, generates the best contextual answer with Claude (using the saved job posting + the proposal you sent + the chat history) and sends it.

Everything runs autonomously. The toolbar popup has a **Start / Pause** button.

> ⚠️ **Account risk.** Workana actively detects automation and may penalize/ban accounts. The extension throttles (randomized delays, an hourly bid cap, a kill-switch) but cannot eliminate this. Test with **Dry run** enabled and on a disposable account first.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`/sdb-disk/workana`).
4. Pin the extension; click it → **⚙ Settings**.

## Configure (Settings)

| Field | Notes |
|---|---|
| Anthropic API key | `sk-ant-...` (stored in `chrome.storage.local`). |
| Model | Default `claude-opus-4-8`. |
| Profile / ranking | Your bio/skills and Workana rank — fed into every proposal. |
| Portfolio projects | Title / one-line result / link. Used for "Highlight your projects" + proposal grounding. |
| Job search URL | Your saved-search URL, e.g. `https://www.workana.com/jobs?agreement=fixed&category=it-programming&...`. |
| Proposal prompt / Reply rules | Instructions for proposal and chat generation. |
| Price strategy | Tiers `{min, max, bid}` + **underbid %** below the Insights average. |
| Poll interval / Max bids per hour | Throttling. |
| **Dry run** | Fill forms but never submit (recommended for first run). |

## Run

- Click the toolbar icon → **Start**. The badge shows `ON`.
- The popup shows live counters (queued, bids this hour, processed, scammers skipped) and recent scam-flagged clients.
- **Pause** halts immediately; in-flight state is preserved and resumes on **Start**.

## How it works

```
background.js  orchestrator: alarms, job queue (1 bid at a time), Claude calls, pricing, scam check
  ├─ lib/storage.js   config + state in chrome.storage.local
  ├─ lib/claude.js    Anthropic Messages API (structured outputs)
  └─ lib/scammer.js   heuristics (published≥3 & paid 0; local client posting in English)
content/
  ├─ dom-utils.js   ALL selectors + helpers (window.WKDom)
  ├─ search.js      scrape job cards on /jobs
  ├─ job.js         /job/<slug> read+scam+bid → /messages/bid/<slug> fill+submit
  └─ messages.js    /messages auto-reply
```

### Scam heuristics

- `Published ≥ 3` projects but `Paid = 0` → skip.
- Client from a Spanish/Portuguese-speaking country but a posting is written in **English** → skip (fake-review pattern). Language guessed locally, with Claude as fallback.

Skipped clients are saved and shown in the popup; the job is never bid on.

## ⚠️ Selector maintenance

Workana ships **obfuscated, changing CSS classes**. All selectors live in **one** file — [`src/content/dom-utils.js`](src/content/dom-utils.js) (the `S` object). If a flow stops working (e.g. the bid form isn't filled, replies aren't detected), open Workana, inspect the element, and update the matching entry there. The content scripts deliberately prefer **visible-text / aria / structural** matching to survive class churn, but the `S` selectors still need a one-time verification against the live DOM.

## Limitations / TODO

- **HTML/screenshot attachments** (when Claude returns a link to attach) are not yet wired — `attachments` are generated but not uploaded. Best-effort Phase 2 via `chrome.tabs.captureVisibleTab`.
- Service worker state (queue/in-flight) is in-memory; `processedJobs` persists, so a worker restart won't double-bid, but may leave an orphan job tab open (closed on next cycle).
