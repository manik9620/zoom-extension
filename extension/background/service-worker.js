const OFFSCREEN_URL = "offscreen/offscreen.html";

// In-memory caches only for speed — never the source of truth. Every write
// below lands in chrome.storage.local immediately, so a killed/evicted
// service worker, a closed side panel, or a closed Zoom tab never loses
// transcript that's already been transcribed.
let cachedActiveMeetingId; // undefined = not yet loaded from storage this wake-up
let cachedCapturingTabId;

async function getActiveMeetingId() {
  if (cachedActiveMeetingId !== undefined) return cachedActiveMeetingId;
  const { activeMeetingId } = await chrome.storage.local.get("activeMeetingId");
  cachedActiveMeetingId = activeMeetingId || null;
  return cachedActiveMeetingId;
}

async function getCapturingTabId() {
  if (cachedCapturingTabId !== undefined) return cachedCapturingTabId;
  const { capturingTabId } = await chrome.storage.local.get("capturingTabId");
  cachedCapturingTabId = capturingTabId || null;
  return cachedCapturingTabId;
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Capture Zoom tab audio for local transcription.",
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// If the tab being captured closes (accidentally or otherwise), stop cleanly
// instead of leaving a dangling capture — whatever was transcribed already
// stays saved since it was written to storage as it arrived.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const capturingTabId = await getCapturingTabId();
  if (tabId === capturingTabId) {
    await stopCapture();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "start-capture") {
    startCapture(message.tabId, message.title, message.meetingId).then(sendResponse).catch((err) => {
      console.error("startCapture failed", err);
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }
  if (message.type === "stop-capture") {
    stopCapture().then(sendResponse);
    return true;
  }
  if (message.type === "transcript-segment") {
    appendTranscript(message.text);
  }
  if (message.type === "generate-notes") {
    generateNotes(message.meetingId).then(sendResponse).catch((err) => {
      console.error("generateNotes failed", err);
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }
  if (message.type === "get-state") {
    getState().then(sendResponse);
    return true;
  }
  if (message.type === "list-meetings") {
    listMeetings().then(sendResponse);
    return true;
  }
  if (message.type === "delete-meeting") {
    deleteMeeting(message.id).then(sendResponse);
    return true;
  }
  // capture-error needs no relay: broadcast from offscreen doc already reaches every context.
});

async function startCapture(tabId, title, resumeMeetingId) {
  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const { meetings = {} } = await chrome.storage.local.get("meetings");

  let id = resumeMeetingId;
  if (!id || !meetings[id]) {
    id = crypto.randomUUID();
    meetings[id] = { id, title: title || "Class recording", date: Date.now(), transcript: "", notes: null };
  }

  await chrome.storage.local.set({ meetings, activeMeetingId: id, capturingTabId: tabId });
  cachedActiveMeetingId = id;
  cachedCapturingTabId = tabId;

  await chrome.runtime.sendMessage({ type: "begin-capture", streamId });
  return { ok: true, meetingId: id, meeting: meetings[id] };
}

async function stopCapture() {
  try {
    await chrome.runtime.sendMessage({ type: "end-capture" });
  } catch (e) {
    // offscreen doc may already be gone (e.g. tab closed) — fine, nothing to clean up there.
  }
  await chrome.storage.local.remove(["activeMeetingId", "capturingTabId"]);
  cachedActiveMeetingId = null;
  cachedCapturingTabId = null;
  return { ok: true };
}

async function appendTranscript(text) {
  const id = await getActiveMeetingId();
  if (!id) return;
  const { meetings = {} } = await chrome.storage.local.get("meetings");
  if (!meetings[id]) return;
  meetings[id].transcript = (meetings[id].transcript || "") + text + " ";
  await chrome.storage.local.set({ meetings });
}

async function getState() {
  const activeMeetingId = await getActiveMeetingId();
  if (!activeMeetingId) return { ok: true, capturing: false };
  const { meetings = {} } = await chrome.storage.local.get("meetings");
  const meeting = meetings[activeMeetingId];
  if (!meeting) return { ok: true, capturing: false };
  return { ok: true, capturing: true, meeting };
}

async function listMeetings() {
  const { meetings = {} } = await chrome.storage.local.get("meetings");
  return { ok: true, meetings: Object.values(meetings).sort((a, b) => b.date - a.date) };
}

async function deleteMeeting(id) {
  const { meetings = {} } = await chrome.storage.local.get("meetings");
  delete meetings[id];
  await chrome.storage.local.set({ meetings });
  return { ok: true };
}

async function generateNotes(meetingId) {
  const { meetings = {} } = await chrome.storage.local.get("meetings");
  const meeting = meetings[meetingId];
  if (!meeting) return { ok: false, error: "meeting not found" };

  const transcript = (meeting.transcript || "").trim();
  if (!transcript) return { ok: false, error: "no transcript captured yet" };

  let res;
  try {
    res = await fetch("http://127.0.0.1:8765/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
    });
  } catch (e) {
    return { ok: false, error: "could not reach local server — is it running? (server/run.sh)" };
  }

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `server error ${res.status}: ${body.slice(0, 200)}` };
  }

  const notes = await res.json();

  const { meetings: latestMeetings = {} } = await chrome.storage.local.get("meetings");
  if (latestMeetings[meetingId]) {
    latestMeetings[meetingId].notes = notes;
    await chrome.storage.local.set({ meetings: latestMeetings });
  }
  return { ok: true, notes };
}
