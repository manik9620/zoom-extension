# Phase 3 — history, export, trust polish, crash-safety

State moved entirely into the background service worker + `chrome.storage.local`
(no more IndexedDB, no more per-panel in-memory transcript). Every transcribed
segment is written to storage the moment it arrives — closing the side panel,
closing the Zoom tab, or the service worker getting evicted by Chrome no
longer loses anything already transcribed.

**History** tab lists every meeting; **View** reloads it, **Delete** removes
it. **Copy as Markdown** / **Download .md** export transcript + notes.
Privacy note shown in the panel.

## Test — normal flow

1. Run a capture session, Stop, generate notes.
2. History tab → meeting appears with guessed title + timestamp.
3. View → transcript/notes reload correctly. Download .md → file reads correctly.
4. Delete → disappears, stays gone after reloading the extension.
5. Reload the whole browser → History still shows past meetings.

## Test — crash-safety edge cases (the important ones)

6. Start a capture, let a few lines of transcript appear, **close the side panel** (X button, not Stop). Reopen it (toolbar icon) — status should say "live — listening (resumed)" and the transcript-so-far should still be there, still growing.
7. Start a capture, let it run, then **close the Zoom tab itself**. Capture should stop cleanly (check `chrome://extensions` → service worker console for no errors); reopen the panel → History tab should show the meeting with whatever was transcribed before the tab closed.
8. Start a capture, then `chrome://extensions` → click the reload icon on the extension mid-capture (simulates the service worker being killed/restarted). Whatever was transcribed before the reload should still be in History afterward — capture itself will stop (offscreen doc is torn down by the reload), which is expected.

---

# Phase 2 — Gemini notes generation

New: **Notes** tab in side panel. After capturing (Stop it first, or even mid-class),
click **Generate Notes** — the extension sends the transcript to the local
server, which calls Gemini free tier and returns structured Topics / Key
Points / Action Items / Summary. The Gemini key lives only in `server/.env` —
it's never entered into the extension UI and never ships in extension code.

## One-time setup

1. Get a free API key: https://aistudio.google.com/apikey
2. `cd server && cp .env.example .env` then paste your key into `.env` (`GEMINI_API_KEY=...`).
3. Reload the extension (`chrome://extensions`).

## Test

1. Start Capture, let some real speech accumulate, Stop.
2. Switch to **Notes** tab → click **Generate Notes**.
3. Should render Summary / Topics / Key Points / Action Items within a few seconds.
4. Error cases to check: no API key set (clear message + link to options), invalid key (Gemini 4xx error message shown, Retry button works).

---

# Phase 1 — local live transcript

Zoom tab audio → offscreen doc (AudioWorklet, downsample to 16kHz PCM16, 2s
chunks) → WebSocket → local server (`server/`, faster-whisper) → text pushed
back → shown live in the side panel. Tab audio still plays normally (verified
in Phase 0).

## One-time server setup

```
cd server
./setup.sh
```

Downloads the `base.en` whisper model on first run (few hundred MB).

## Before each class

```
cd server
./run.sh
```

Leave this terminal window open during class. It's listening on
`ws://127.0.0.1:8765`.

## Load/reload the extension

1. `chrome://extensions` → Developer mode on → "Load unpacked" → select `extension/` (or click the reload icon if already loaded).
2. Join the Zoom meeting tab, make it the active tab.
3. Open the extension's side panel (toolbar icon).
4. Click **Start Capture**.

## What to test

1. Transcript text should start appearing in the side panel a few seconds after someone speaks (first chunk takes longest — model warms up on server startup, not per-request).
2. You should still hear the meeting audio normally the whole time.
3. If side panel shows "error: could not connect to local transcription server" — the server isn't running or crashed; check the `run.sh` terminal for a Python traceback.
4. Click **Stop** — capture releases, audio keeps playing, no more transcript lines appear.
