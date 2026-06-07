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

async function callClaude(config, { system, user, schema, maxTokens = 2048 }) {
  if (!config.apiKey) throw new Error("Missing Anthropic API key");
  const body = {
    model: config.model || "claude-opus-4-8",
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema } },
  };
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude returned no text block");
  return JSON.parse(textBlock.text);
}

export async function generateProposal(config, { description, clientName, country }) {
  const system =
    "You are an expert Workana freelancer writing winning bid proposals. " +
    config.proposalPrompt;
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
      `projects (max 3 exact portfolio titles), deliveryTime (e.g. "7 days"), ` +
      `attachments (array of URLs from my portfolio worth attaching, or []).`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return callClaude(config, { system, user, schema: PROPOSAL_SCHEMA });
}

export async function generateReply(config, { jobPosting, sentProposal, chatHistory, newMessage }) {
  const system =
    "You are an expert Workana freelancer continuing a chat with a client. " + config.replyRules;
  const user = [
    `JOB POSTING:\n${jobPosting || "(unknown)"}`,
    `THE PROPOSAL I SENT:\n${sentProposal || "(unknown)"}`,
    `CHAT HISTORY (oldest first):\n${chatHistory}`,
    `CLIENT'S NEW MESSAGE:\n${newMessage}`,
    `\nReturn replyText (same language/tone as the client) and shouldEscalate (true if a human should handle it).`,
  ].join("\n\n");
  return callClaude(config, { system, user, schema: REPLY_SCHEMA, maxTokens: 1024 });
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
