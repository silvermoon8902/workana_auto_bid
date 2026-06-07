// messages.js — runs on /messages*. Detects new client replies and sends
// Claude-generated answers. No-ops on the /messages/bid/<slug> bid form (job.js owns that).

(function () {
  if (/\/messages\/bid\//i.test(location.pathname)) return;

  const D = window.WKDom;
  const { textOf, qa, waitForSelector, setReactValue, humanDelay, sleep, sanitizeOutgoing, S } = D;
  const send = (msg) => chrome.runtime.sendMessage(msg);

  let running = false;

  function unreadConversations() {
    const items = qa(S.conversationItem).filter((el) => el.offsetParent !== null);
    return items.filter((el) => {
      if (el.querySelector(S.unreadBadge)) return true;
      // Bold/strong styling often marks unread threads.
      const fw = getComputedStyle(el).fontWeight;
      return Number(fw) >= 600 || fw === "bold";
    });
  }

  // Classify each chat bubble as mine (right-aligned) vs client (left-aligned).
  function scrapeThread() {
    const bubbles = qa(S.messageBubble).filter((b) => b.offsetParent !== null && textOf(b));
    const container = bubbles[0]?.closest("[class*='message'], [class*='chat'], main") || document.body;
    const mid = container.getBoundingClientRect().left + container.getBoundingClientRect().width / 2;
    const msgs = bubbles.map((b) => {
      const r = b.getBoundingClientRect();
      const center = r.left + r.width / 2;
      return { who: center > mid ? "me" : "client", text: textOf(b) };
    });
    const header = textOf(qa("h1,h2,[class*='title'],[class*='header']")[0]) || document.title;
    return { msgs, jobTitle: header };
  }

  function threadIdOf() {
    const m = location.pathname.match(/\/messages\/([^/?#]+)/i);
    return m ? m[1] : "active";
  }

  async function processOpenThread() {
    await humanDelay(700, 1300);
    const { msgs, jobTitle } = scrapeThread();
    if (!msgs.length) return;
    if (msgs[msgs.length - 1].who !== "client") return; // last word was mine → nothing to answer

    const chatHistory = msgs.map((m) => `${m.who === "me" ? "ME" : "CLIENT"}: ${m.text}`).join("\n");
    const newMessage = [...msgs].reverse().find((m) => m.who === "client").text;

    const resp = await send({
      type: "CHAT_REPLY",
      threadId: threadIdOf(),
      jobTitle,
      chatHistory,
      newMessage,
    });
    if (!resp || !resp.replyText || resp.shouldEscalate || resp.skip) return;

    const box = await waitForSelector(S.replyBox, { timeout: 4000 });
    if (!box) return;
    const safe = sanitizeOutgoing(resp.replyText);
    if (box.isContentEditable) {
      box.focus();
      box.textContent = safe;
      box.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      setReactValue(box, safe);
    }
    await humanDelay();

    if (resp.dryRun) {
      console.log("[Workana auto-reply] DRY RUN — reply drafted, not sending.", resp.replyText);
      return;
    }
    const sendBtn = document.querySelector(S.sendButton);
    if (sendBtn) sendBtn.click();
    await send({ type: "CHAT_SENT", threadId: threadIdOf() });
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      const ask = await send({ type: "MESSAGES_ENABLED" });
      if (!ask || !ask.enabled) return;

      // Handle the currently open thread, then sweep unread ones.
      await processOpenThread();

      const unread = unreadConversations().slice(0, 5);
      for (const item of unread) {
        item.click();
        await humanDelay(1000, 2000);
        await processOpenThread();
      }
    } finally {
      running = false;
    }
  }

  // Initial pass + light polling while the page is open.
  run();
  setInterval(run, 60_000);
})();
