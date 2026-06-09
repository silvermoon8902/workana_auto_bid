// claude.js — Anthropic Messages API wrapper (called from the background service worker).
// Uses structured outputs so proposals/replies come back as validated JSON.

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    proposalText: { type: "string" },
    skills: { type: "array", items: { type: "string" } },
    projects: { type: "array", items: { type: "string" } },
    deliveryTime: { type: "string" },
    attachments: { type: "array", items: { type: "string" } },
  },
  required: ["proposalText", "skills", "projects", "deliveryTime", "attachments"],
  additionalProperties: false,
};

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    replyText: { type: "string" },
    shouldEscalate: { type: "boolean" },
  },
  required: ["replyText", "shouldEscalate"],
  additionalProperties: false,
};

const LANG_SCHEMA = {
  type: "object",
  properties: { language: { type: "string" } }, // ISO-ish name e.g. "english", "spanish", "portuguese"
  required: ["language"],
  additionalProperties: false,
};

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 529]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Robustly pull a JSON object out of a model response: handles pure JSON,
// ```json fenced blocks, and JSON embedded in prose. Returns null if no COMPLETE
// object is present (e.g. the output was truncated mid-object).
function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const t = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(t);
  } catch {}
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') inStr = !inStr;
    else if (!inStr) {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(t.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null; // unbalanced → truncated
}

async function callClaude(config, { system, user, schema, maxTokens = 2048 }, attempt = 0) {
  if (!config.apiKey) throw new Error("Missing Anthropic API key");
  const body = {
    model: config.model || "claude-opus-4-8",
    max_tokens: maxTokens,
    // No thinking: output_config already forces pure JSON, and thinking tokens
    // would eat into max_tokens and TRUNCATE the JSON (→ "not valid JSON").
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema } },
  };

  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40000); // don't hang forever on a stalled proxy
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (netErr) {
    // Network blip / timeout — retry once (keeps total time bounded).
    if (attempt < 2) {
      await sleep(1000 * 2 ** attempt);
      return callClaude(config, { system, user, schema, maxTokens }, attempt + 1);
    }
    throw netErr;
  }

  if (!res.ok) {
    const text = await res.text();
    if (RETRYABLE.has(res.status) && attempt < 2) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      await sleep(Math.max(retryAfter * 1000, 1000 * 2 ** attempt));
      return callClaude(config, { system, user, schema, maxTokens }, attempt + 1);
    }
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  const parsed = extractJson(textBlock ? textBlock.text : "");
  if (parsed) return parsed;

  // No complete JSON — almost always truncation. Retry with a bigger budget.
  if (attempt < 2) {
    const next = (data.stop_reason === "max_tokens" ? maxTokens : Math.max(maxTokens, 4096)) * 2;
    return callClaude(config, { system, user, schema, maxTokens: next }, attempt + 1);
  }
  throw new Error("Claude response was not valid JSON");
}

export async function generateProposal(config, { description, clientName, country }) {
  const system =
    "You are an expert Workana freelancer writing winning bid proposals. " +
    config.proposalPrompt +
    " Keep proposalText under ~180 words." +
    " Do NOT write any price, budget, total, fee, or delivery-time/timeline line inside proposalText" +
    " (no 'TotalBudget', no 'Timeline', no '$' amounts, no 'X days') — those are entered in the" +
    " separate Budget and delivery fields, so repeating them only risks contradicting the real values." +
    " Output ONLY a single valid JSON object matching the schema — no markdown fences, no text before or after.";
  const user = [
    `MY PROFILE:\n${config.profile}`,
    config.ranking ? `MY WORKANA RANKING: ${config.ranking}` : "",
    `MY PORTFOLIO PROJECTS (pick the most relevant to highlight, max 3, return their exact titles in "projects"):\n` +
      (config.projects || [])
        .map((p) => `- ${p.title}: ${p.summary} (${p.link})`)
        .join("\n"),
    clientName ? `CLIENT: ${clientName}${country ? " from " + country : ""}` : "",
    `PROJECT DESCRIPTION:\n${description}`,
    `\nReturn: proposalText (in the project's language), skills (max 5 to highlight that match this project), ` +
      `projects (max 3 exact portfolio titles), ` +
      `deliveryTime in the SAME language as the proposal (e.g. "7 days" / "7 dias" / "7 días"), ` +
      `attachments (array of URLs from my portfolio worth attaching, or []).`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return callClaude(config, { system, user, schema: PROPOSAL_SCHEMA, maxTokens: 4096 });
}

export async function generateReply(config, { jobPosting, sentProposal, chatHistory, newMessage }) {
  const system =
    "You are an expert Workana freelancer continuing a chat with a client. " +
    config.replyRules +
    " Output ONLY a single valid JSON object matching the schema — no markdown fences, no text before or after.";
  const user = [
    `JOB POSTING:\n${jobPosting || "(unknown)"}`,
    `THE PROPOSAL I SENT:\n${sentProposal || "(unknown)"}`,
    `CHAT HISTORY (oldest first):\n${chatHistory}`,
    `CLIENT'S NEW MESSAGE:\n${newMessage}`,
    `\nReturn replyText (same language/tone as the client) and shouldEscalate (true if a human should handle it).`,
  ].join("\n\n");
  return callClaude(config, { system, user, schema: REPLY_SCHEMA, maxTokens: 1024 });
}

const FOLLOWUP_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
};

// Short follow-up message posted in the /inbox thread right after bidding.
export async function generateFollowUp(config, { description, proposal }) {
  const system =
    "You are a Workana freelancer sending a SHORT, friendly follow-up message right after submitting a proposal, to nudge the client to reply. " +
    (config.followUpPrompt || "") +
    " Under 55 words, in the SAME language as the project. No contact info, no external links, no prices or deadlines." +
    " Output ONLY a single valid JSON object matching the schema — no markdown fences, no text before or after.";
  const user = [
    `PROJECT:\n${(description || "").slice(0, 1500)}`,
    `MY PROPOSAL (already sent):\n${(proposal || "").slice(0, 1500)}`,
    `\nReturn { message } — a brief follow-up (e.g. offer to share relevant samples, ask one quick engaging question).`,
  ].join("\n\n");
  const out = await callClaude(config, { system, user, schema: FOLLOWUP_SCHEMA, maxTokens: 512 });
  return out.message;
}

// Fallback language classifier for the scam heuristic.
export async function detectLanguage(config, text) {
  const out = await callClaude(config, {
    system: "Identify the primary natural language of the text.",
    user: `Text:\n${text.slice(0, 1500)}\n\nReturn the language name in lowercase english (e.g. "english", "spanish", "portuguese").`,
    schema: LANG_SCHEMA,
    maxTokens: 64,
  });
  return (out.language || "").toLowerCase();
}
