import json

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from notes import NotesError, generate_notes
from transcriber import get_model, transcribe_pcm16

app = FastAPI()

# The extension's background page calls this server as chrome-extension://<id>,
# which is a cross-origin request from the server's point of view.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


class NotesRequest(BaseModel):
    transcript: str


@app.post("/notes")
def notes_endpoint(req: NotesRequest):
    try:
        return generate_notes(req.transcript)
    except NotesError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.on_event("startup")
def warm_up_model():
    # Load the whisper model once at startup so the first real chunk isn't slow.
    get_model()


@app.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket):
    await websocket.accept()
    sample_rate = 16000
    try:
        while True:
            message = await websocket.receive()
            if "text" in message and message["text"] is not None:
                data = json.loads(message["text"])
                if data.get("type") == "start":
                    sample_rate = data.get("sampleRate", 16000)
                continue
            if "bytes" in message and message["bytes"] is not None:
                pcm_bytes = message["bytes"]
                if len(pcm_bytes) < 2:
                    continue
                text = transcribe_pcm16(pcm_bytes, sample_rate=sample_rate)
                if text:
                    await websocket.send_text(json.dumps({"type": "segment", "text": text}))
    except WebSocketDisconnect:
        pass
