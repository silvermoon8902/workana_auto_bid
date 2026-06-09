// inbox.js — runs on /inbox/<slug>/<user>, the conversation Workana opens right
// after a bid is submitted. Posts a short follow-up message (and best-effort
// project screenshots) — but ONLY for the bid that was just submitted.

(function () {
  const D = window.WKDom;
  const { qa, waitForSelector, setReactValue, humanDelay, sanitizeOutgoing, send, contextValid, S } = D;

  const m = location.pathname.match(/\/inbox\/([^/?#]+)/i);
  const slug = m ? m[1] : null;
  if (!slug) return;

  function dataUrlToFile(dataUrl, filename) {
    const [meta, b64] = dataUrl.split(",");
    const mime = (meta.match(/data:(.*?);/) || [, "image/png"])[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], filename, { type: mime });
  }

  // Best-effort: attach project screenshots to the chat's file input, if present.
  async function attachToChat(urls) {
    const list = (urls || []).filter(Boolean);
    if (!list.length) return;
    const input = document.querySelector(S.chatFileInput);
    if (!input) return;
    const resp = await send({ type: "CAPTURE", urls: list });
    const shots = (resp && resp.shots) || [];
    for (const shot of shots) {
      try {
        const file = dataUrlToFile(shot.dataUrl, shot.filename || "project.png");
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await humanDelay(1500, 2500);
      } catch {}
    }
  }

  async function run() {
    if (!contextValid()) return;
    await humanDelay(1200, 2200); // let the thread render

    const resp = await send({ type: "GET_FOLLOWUP", slug });
    if (!resp || !resp.message) return; // not the just-bid thread, or nothing to send

    const box = await waitForSelector(S.replyBox, { timeout: 6000 });
    if (!box) {
      await send({ type: "FOLLOWUP_DONE", slug, sent: false });
      return;
    }

    await attachToChat(resp.attachments); // best-effort screenshots

    const safe = sanitizeOutgoing(resp.message);
    if (box.isContentEditable) {
      box.focus();
      box.textContent = safe;
      box.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      setReactValue(box, safe);
    }
    await humanDelay(800, 1400);

    let sent = false;
    if (resp.dryRun) {
      console.log("[WK inbox] DRY RUN — follow-up drafted, not sent:", safe);
    } else {
      const btn = qa(S.sendButton).find((b) => b.offsetParent !== null) || document.querySelector(S.sendButton);
      if (btn) {
        btn.click();
        sent = true;
      }
    }
    await send({ type: "FOLLOWUP_DONE", slug, sent, title: document.title });
  }

  run();
})();
