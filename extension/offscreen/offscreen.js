const SERVER_URL = "ws://127.0.0.1:8765/ws/transcribe";
const TARGET_SAMPLE_RATE = 16000;

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let socket = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "begin-capture") {
    beginCapture(message.streamId).catch((err) => {
      console.error("beginCapture failed", err);
      chrome.runtime.sendMessage({ type: "capture-error", error: String(err) });
    });
  }
  if (message.type === "end-capture") {
    endCapture();
  }
});

function connectSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "start", sampleRate: TARGET_SAMPLE_RATE }));
      resolve(ws);
    };
    ws.onerror = () => reject(new Error("could not connect to local transcription server"));
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "segment" && data.text) {
          chrome.runtime.sendMessage({ type: "transcript-segment", text: data.text });
        }
      } catch (e) {
        console.error("bad message from server", e);
      }
    };
    ws.onclose = () => {
      console.log("[offscreen] server socket closed");
    };
  });
}

async function beginCapture(streamId) {
  socket = await connectSocket();

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule("audio-worklet-processor.js");

  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  // Route back to speakers so the user still hears the class.
  sourceNode.connect(audioContext.destination);

  // Parallel tap: worklet downsamples + chunks + streams PCM16 to the local server.
  workletNode = new AudioWorkletNode(audioContext, "pcm-chunk-processor");
  sourceNode.connect(workletNode);

  workletNode.port.onmessage = (event) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(event.data);
    }
  };

  console.log("[offscreen] capture started, contextSampleRate=", audioContext.sampleRate);
}

function endCapture() {
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
  console.log("[offscreen] capture stopped");
}
