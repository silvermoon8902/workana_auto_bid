// scammer.js — client risk heuristics (runs in the background worker).
// Input is the client/job data scraped by job.js. Returns { flagged, reasons[] }.

const SPANISH_PT_COUNTRIES = new Set([
  // Portuguese
  "brazil", "brasil", "portugal", "angola", "mozambique",
  // Spanish
  "argentina", "mexico", "méxico", "colombia", "chile", "peru", "perú",
  "spain", "españa", "venezuela", "ecuador", "guatemala", "bolivia",
  "dominican republic", "honduras", "paraguay", "el salvador", "nicaragua",
  "costa rica", "panama", "panamá", "uruguay", "cuba",
]);

// Cheap, dependency-free language guess from the posting text.
// Returns "english" | "spanish" | "portuguese" | "unknown".
export function guessLanguage(text) {
  if (!text) return "unknown";
  const t = " " + text.toLowerCase().replace(/[^\p{L}\s]/gu, " ") + " ";
  const score = { english: 0, spanish: 0, portuguese: 0 };
  const buckets = {
    english: [" the ", " and ", " for ", " with ", " you ", " we ", " is ", " are ", " this ", " our ", " your ", " need ", " looking "],
    spanish: [" el ", " la ", " los ", " las ", " para ", " con ", " una ", " que ", " del ", " por ", " busco ", " necesito ", " desarrollo "],
    portuguese: [" o ", " os ", " uma ", " para ", " com ", " que ", " você ", " nós ", " desenvolvimento ", " precisamos ", " atendimento ", " não "],
  };
  for (const [lang, words] of Object.entries(buckets)) {
    for (const w of words) {
      let idx = 0;
      while ((idx = t.indexOf(w, idx)) !== -1) {
        score[lang]++;
        idx += w.length;
      }
    }
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] === 0 ? "unknown" : best[0];
}

export function isSpanishOrPortugueseCountry(country) {
  if (!country) return false;
  return SPANISH_PT_COUNTRIES.has(country.trim().toLowerCase());
}

// Build the set of skip countries: built-in defaults + user-configured list.
function parseBlocked(blocked) {
  const set = new Set(["ukraine", "ucrania", "ucrânia", "philippines", "filipinas"]);
  if (Array.isArray(blocked)) blocked.forEach((c) => c && set.add(String(c).trim().toLowerCase()));
  else if (typeof blocked === "string")
    blocked.split(",").forEach((c) => c.trim() && set.add(c.trim().toLowerCase()));
  return set;
}

// data: { clientName, country, publishedCount, paidCount, postingText, priorPostingLangs[], postingLang, blockedCountries }
export function assessClient(data) {
  const reasons = [];

  // Rule 0: client from a blocked country (mostly scammers) → skip.
  const blocked = parseBlocked(data.blockedCountries);
  if (data.country && blocked.has(data.country.trim().toLowerCase())) {
    reasons.push(`Client country (${data.country}) is on the skip list.`);
  }

  // Rule 1: lots of postings, zero payments → likely never pays.
  if (Number(data.publishedCount) >= 3 && Number(data.paidCount) === 0) {
    reasons.push(
      `Published ${data.publishedCount} projects but paid 0 — likely non-paying client.`
    );
  }

  // Rule 2: local client (ES/PT country) posting in English → fake-review pattern.
  const localCountry = isSpanishOrPortugueseCountry(data.country);
  const langs = new Set(
    [data.postingLang, ...(data.priorPostingLangs || [])].filter(Boolean)
  );
  if (localCountry && langs.has("english")) {
    reasons.push(
      `Client from ${data.country} but a posting is written in English — possible fake-review/scam pattern.`
    );
  }

  return { flagged: reasons.length > 0, reasons };
}
