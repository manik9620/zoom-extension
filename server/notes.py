import json
import os
import time

import requests

GEMINI_MODEL = "gemini-3.6-flash"
MAX_CHARS = 100000  # guard against context-length errors on very long classes

SCHEMA = {
    "type": "object",
    "properties": {
        "topics": {"type": "array", "items": {"type": "string"}},
        "key_points": {"type": "array", "items": {"type": "string"}},
        "action_items": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["topics", "key_points", "action_items", "summary"],
}

PROMPT_TEMPLATE = """You are summarizing a university class transcript for a student's notes.
Given this class transcript, produce structured notes:
- topics: main subjects/concepts covered
- key_points: concise key ideas explained (not verbatim quotes)
- action_items: homework, deadlines, or follow-ups explicitly mentioned (empty array if none)
- summary: a 2-3 sentence overview of the class

Transcript:
{transcript}"""


class NotesError(Exception):
    pass


def generate_notes(transcript: str) -> dict:
    transcript = transcript.strip()
    if not transcript:
        raise NotesError("no transcript provided")

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise NotesError("GEMINI_API_KEY not set in server/.env")

    truncated = transcript[:MAX_CHARS] + (" …[truncated]" if len(transcript) > MAX_CHARS else "")
    prompt = PROMPT_TEMPLATE.format(transcript=truncated)

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA},
    }

    resp = requests.post(url, params={"key": api_key}, json=body, timeout=60)
    if resp.status_code == 429:
        time.sleep(3)
        resp = requests.post(url, params={"key": api_key}, json=body, timeout=60)

    if not resp.ok:
        raise NotesError(f"Gemini API error {resp.status_code}: {resp.text[:200]}")

    data = resp.json()
    try:
        text_part = data["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text_part)
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        raise NotesError(f"could not parse Gemini response: {e}")
