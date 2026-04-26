// Browser Whisper transcription using @huggingface/transformers (Transformers.js v3+)
// Returns word-level timestamps suitable for karaoke-style captions.

import { pipeline, env } from "@huggingface/transformers";

// Use HF CDN; allow remote downloads of the model
env.allowLocalModels = false;

export type WordTiming = { word: string; start: number; end: number };
export type TranscriptionResult = {
  text: string;
  words: WordTiming[];
};

let transcriberPromise: Promise<any> | null = null;
let transcriberDevice: "webgpu" | "wasm" = "wasm";

async function detectWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export async function getTranscriber(
  onProgress?: (msg: string, pct?: number) => void,
) {
  if (!transcriberPromise) {
    const hasWebGPU = await detectWebGPU();
    transcriberDevice = hasWebGPU ? "webgpu" : "wasm";
    console.log("[transcribe] device:", transcriberDevice);
    onProgress?.(
      `Loading Whisper tiny model (~40MB) on ${transcriberDevice.toUpperCase()}…`,
      0,
    );
    transcriberPromise = pipeline(
      "automatic-speech-recognition",
      "onnx-community/whisper-tiny_timestamped",
      {
        device: transcriberDevice,
        dtype: hasWebGPU ? "fp32" : "q8",
        progress_callback: (data: any) => {
          if (data.status === "progress") {
            const pct = Math.round(data.progress ?? 0);
            const file = data.file ? ` ${data.file}` : "";
            onProgress?.(`Downloading model${file}… ${pct}%`, pct);
            console.log("[transcribe] download", file, pct + "%");
          } else if (data.status === "done") {
            console.log("[transcribe] file ready:", data.file);
          } else if (data.status === "ready") {
            onProgress?.("Model loaded", 100);
            console.log("[transcribe] model ready");
          }
        },
      } as any,
    ).catch((err) => {
      transcriberPromise = null;
      throw err;
    });
  }
  return transcriberPromise;
}

// Decode any media (video or audio) file to mono Float32Array @ 16 kHz
export async function decodeAudioFromFile(file: File): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer();
  // Use a 16k AudioContext where possible (Whisper expects 16 kHz)
  const AudioCtx: typeof AudioContext =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: 16000 });
  const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  // Mix down to mono
  const channelData: Float32Array =
    decoded.numberOfChannels === 1
      ? decoded.getChannelData(0)
      : mixToMono(decoded);
  // Resample if needed (rare — most browsers honor the requested sampleRate)
  const finalAudio =
    decoded.sampleRate === 16000
      ? channelData
      : await resample(channelData, decoded.sampleRate, 16000);
  ctx.close().catch(() => {});
  return finalAudio;
}

function mixToMono(buf: AudioBuffer): Float32Array {
  const len = buf.length;
  const out = new Float32Array(len);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += data[i] / buf.numberOfChannels;
  }
  return out;
}

async function resample(
  audio: Float32Array,
  fromRate: number,
  toRate: number,
): Promise<Float32Array> {
  const offline = new OfflineAudioContext(
    1,
    Math.ceil((audio.length * toRate) / fromRate),
    toRate,
  );
  const buf = offline.createBuffer(1, audio.length, fromRate);
  // Copy into a fresh Float32Array<ArrayBuffer> for strict typings
  const safe = new Float32Array(audio.length);
  safe.set(audio);
  buf.copyToChannel(safe, 0);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

export async function transcribeFile(
  file: File,
  onProgress?: (msg: string, pct?: number) => void,
): Promise<TranscriptionResult> {
  console.log("[transcribe] start", file.name, file.size);
  const transcriber = await getTranscriber(onProgress);
  onProgress?.("Decoding audio…", 5);
  console.log("[transcribe] decoding audio");
  const audio = await decodeAudioFromFile(file);
  const seconds = audio.length / 16000;
  console.log("[transcribe] decoded", seconds.toFixed(1), "s of audio");
  onProgress?.(
    `Transcribing ${seconds.toFixed(0)}s of audio on ${transcriberDevice.toUpperCase()}…`,
    10,
  );

  // Heartbeat so the UI doesn't appear frozen during the long inference call
  let pct = 10;
  const heartbeat = setInterval(() => {
    pct = Math.min(90, pct + 2);
    onProgress?.(
      `Transcribing… (${transcriberDevice.toUpperCase()}, ${seconds.toFixed(0)}s audio)`,
      pct,
    );
  }, 1500);

  let output: any;
  try {
    output = await transcriber(audio, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
  } finally {
    clearInterval(heartbeat);
  }
  console.log("[transcribe] done, chunks:", output?.chunks?.length);

  const chunks: any[] = output.chunks ?? [];
  const words: WordTiming[] = chunks
    .filter((c) => c.timestamp && c.timestamp[0] != null && c.timestamp[1] != null)
    .map((c) => ({
      word: String(c.text).trim(),
      start: Number(c.timestamp[0]),
      end: Number(c.timestamp[1]),
    }))
    .filter((w) => w.word.length > 0 && w.end > w.start);

  // Patch any missing end-times with the next start-time
  for (let i = 0; i < words.length - 1; i++) {
    if (!isFinite(words[i].end) || words[i].end <= words[i].start) {
      words[i].end = Math.max(words[i].start + 0.15, words[i + 1].start - 0.02);
    }
  }
  if (words.length && (!isFinite(words[words.length - 1].end) || words[words.length - 1].end <= words[words.length - 1].start)) {
    words[words.length - 1].end = words[words.length - 1].start + 0.5;
  }

  return {
    text: String(output.text ?? words.map((w) => w.word).join(" ")).trim(),
    words,
  };
}
