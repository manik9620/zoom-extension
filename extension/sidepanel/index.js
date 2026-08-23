const mainActionBtn = document.getElementById("mainAction");
const startNewBtn = document.getElementById("startNew");
const statusEl = document.getElementById("status");
const statusDot = document.getElementById("statusDot");
const transcriptEl = document.getElementById("transcript");
const tabBtns = document.querySelectorAll(".tab-btn");
const panels = {
  transcript: transcriptEl,
  notes: document.getElementById("notes"),
  history: document.getElementById("history"),
};
const notesEmpty = document.getElementById("notesEmpty");
const notesContent = document.getElementById("notesContent");
const notesBody = document.getElementById("notesBody");
const copyMdBtn = document.getElementById("copyMd");
const downloadMdBtn = document.getElementById("downloadMd");
const historyList = document.getElementById("historyList");

// Only an id + display copy of what's on screen — actual state of record
// lives in the background service worker + chrome.storage.local, so a
// closed/reopened panel never loses anything already transcribed.
let viewingMeetingId = null;
let uiState = "idle"; // idle | live | stopped

function setStatus(text, mode) {
  statusEl.textContent = text;
  statusDot.className = "dot" + (mode ? " " + mode : "");
}

function setUiState(next) {
  uiState = next;
  mainActionBtn.classList.remove("state-idle", "state-live", "state-stopped");
  mainActionBtn.classList.add("state-" + next);
  if (next === "idle") {
    mainActionBtn.textContent = "Start Capture";
    startNewBtn.style.display = "none";
  } else if (next === "live") {
    mainActionBtn.textContent = "Stop";
    startNewBtn.style.display = "none";
  } else if (next === "stopped") {
    mainActionBtn.textContent = "Continue";
    startNewBtn.style.display = "block";
  }
}

function timestampedTitle() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return `Recording_${date}_${time}`;
}

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    Object.entries(panels).forEach(([key, el]) => el.classList.toggle("active", key === btn.dataset.tab));
    if (btn.dataset.tab === "history") renderHistory();
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "transcript-segment") {
    const span = document.createElement("span");
    span.className = "seg";
    span.textContent = message.text + " ";
    transcriptEl.appendChild(span);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  if (message.type === "capture-error") {
    setStatus("error: " + message.error, "error");
  }
});

async function rehydrate() {
  const state = await chrome.runtime.sendMessage({ type: "get-state" });
  if (state && state.capturing && state.meeting) {
    viewingMeetingId = state.meeting.id;
    transcriptEl.textContent = state.meeting.transcript || "";
    resetNotesPanel();
    if (state.meeting.notes) renderNotes(state.meeting.notes);
    setStatus("live — listening (resumed)", "live");
    setUiState("live");
  }
}
rehydrate();

async function beginOrResumeCapture(resumeMeetingId) {
  setStatus("starting...");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/([a-z0-9-]+\.)?zoom\.us\//.test(tab.url || "")) {
    setStatus("open a Zoom meeting tab first (current: " + (tab && tab.url) + ")", "error");
    return;
  }

  if (!resumeMeetingId) {
    transcriptEl.textContent = "";
    resetNotesPanel();
  }

  const res = await chrome.runtime.sendMessage({
    type: "start-capture",
    tabId: tab.id,
    title: timestampedTitle(),
    meetingId: resumeMeetingId || undefined,
  });
  if (res && res.ok) {
    viewingMeetingId = res.meetingId;
    setStatus("live — listening", "live");
    setUiState("live");
  } else {
    setStatus("error: " + (res && res.error), "error");
  }
}

async function stopCapture() {
  await chrome.runtime.sendMessage({ type: "stop-capture" });
  setStatus("stopped — capture paused");
  setUiState("stopped");
}

mainActionBtn.addEventListener("click", () => {
  if (uiState === "idle") beginOrResumeCapture(null);
  else if (uiState === "live") stopCapture();
  else if (uiState === "stopped") beginOrResumeCapture(viewingMeetingId);
});

startNewBtn.addEventListener("click", () => {
  viewingMeetingId = null;
  setUiState("idle");
  beginOrResumeCapture(null);
});

function resetNotesPanel() {
  notesContent.style.display = "none";
  notesEmpty.style.display = "block";
  notesEmpty.innerHTML =
    'No notes yet. Stop capture, then generate notes from the transcript.<br /><button id="generateNotes">Generate Notes</button>';
  document.getElementById("generateNotes").addEventListener("click", onGenerateNotes);
}
resetNotesPanel();

async function onGenerateNotes() {
  if (!viewingMeetingId) {
    notesEmpty.innerHTML = "Start a capture first.";
    return;
  }
  const btn = document.getElementById("generateNotes");
  btn.disabled = true;
  btn.textContent = "Generating…";
  const res = await chrome.runtime.sendMessage({ type: "generate-notes", meetingId: viewingMeetingId });
  btn.disabled = false;
  btn.textContent = "Generate Notes";

  if (!res || !res.ok) {
    notesEmpty.innerHTML =
      "Couldn't generate notes: " +
      escapeHtml((res && res.error) || "unknown error") +
      '<br /><button id="generateNotes">Retry</button>';
    document.getElementById("generateNotes").addEventListener("click", onGenerateNotes);
    return;
  }

  renderNotes(res.notes);
}

function renderNotes(notes) {
  notesEmpty.style.display = "none";
  notesContent.style.display = "block";

  const section = (title, bodyHtml) => `
    <div class="notes-section">
      <h3>${title}</h3>
      ${bodyHtml}
    </div>`;

  const list = (items) =>
    items && items.length
      ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
      : `<p style="color:var(--text-dim)">None</p>`;

  notesBody.innerHTML =
    section("Summary", `<p>${escapeHtml(notes.summary || "")}</p>`) +
    section("Topics", list(notes.topics)) +
    section("Key Points", list(notes.key_points)) +
    section("Action Items", list(notes.action_items));
}

function toMarkdown(meeting) {
  const notes = meeting.notes || {};
  const dateStr = new Date(meeting.date).toLocaleString();
  const list = (items) => (items && items.length ? items.map((i) => `- ${i}`).join("\n") : "_None_");
  return `# ${meeting.title || "Class recording"}
_${dateStr}_

## Summary
${notes.summary || "_Not generated_"}

## Topics
${list(notes.topics)}

## Key Points
${list(notes.key_points)}

## Action Items
${list(notes.action_items)}

## Full Transcript
${meeting.transcript || "_empty_"}
`;
}

async function currentMeetingRecord() {
  if (!viewingMeetingId) return null;
  const res = await chrome.runtime.sendMessage({ type: "list-meetings" });
  const meetings = (res && res.meetings) || [];
  return meetings.find((m) => m.id === viewingMeetingId) || null;
}

copyMdBtn.addEventListener("click", async () => {
  const meeting = await currentMeetingRecord();
  if (!meeting) return;
  await navigator.clipboard.writeText(toMarkdown(meeting));
  copyMdBtn.textContent = "Copied!";
  setTimeout(() => (copyMdBtn.textContent = "Copy as Markdown"), 1200);
});

downloadMdBtn.addEventListener("click", async () => {
  const meeting = await currentMeetingRecord();
  if (!meeting) return;
  const blob = new Blob([toMarkdown(meeting)], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(meeting.title || "class-notes").replace(/[^a-z0-9]+/gi, "-")}.md`;
  a.click();
  URL.revokeObjectURL(url);
});

async function renderHistory() {
  const res = await chrome.runtime.sendMessage({ type: "list-meetings" });
  const meetings = (res && res.meetings) || [];
  if (!meetings.length) {
    historyList.innerHTML = "";
    return;
  }
  historyList.innerHTML = meetings
    .map(
      (m) => `
    <div class="history-item" data-id="${m.id}">
      <div class="title">${escapeHtml(m.title || "Class recording")}</div>
      <div class="date">${new Date(m.date).toLocaleString()}</div>
      <div class="row">
        <button data-action="view" data-id="${m.id}">View</button>
        <button data-action="delete" data-id="${m.id}" class="danger">Delete</button>
      </div>
    </div>`
    )
    .join("");

  historyList.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.dataset.action === "view") {
        const meetings2 = ((await chrome.runtime.sendMessage({ type: "list-meetings" })) || {}).meetings || [];
        const meeting = meetings2.find((m) => m.id === btn.dataset.id);
        if (meeting) viewArchivedMeeting(meeting);
      } else if (btn.dataset.action === "delete") {
        await chrome.runtime.sendMessage({ type: "delete-meeting", id: btn.dataset.id });
        renderHistory();
      }
    });
  });
}

function viewArchivedMeeting(meeting) {
  viewingMeetingId = meeting.id;
  transcriptEl.textContent = meeting.transcript || "";
  if (meeting.notes) {
    renderNotes(meeting.notes);
  } else {
    resetNotesPanel();
  }
  tabBtns.forEach((b) => b.classList.remove("active"));
  document.querySelector('.tab-btn[data-tab="transcript"]').classList.add("active");
  Object.entries(panels).forEach(([key, el]) => el.classList.toggle("active", key === "transcript"));
  setStatus("viewing archived meeting");
  setUiState("stopped");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
