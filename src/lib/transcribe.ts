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

export type DeviceInfo = {
  device: "webgpu" | "wasm";
  dtype: "fp16" | "q8";
  label: string; // human-readable, e.g. "WebGPU · fp16"
  // Approx realtime factor: seconds of audio processed per wall-clock second.
  // Tiny model: WebGPU/fp16 ~10x, WASM/q8 ~1.5x (conservative).
  realtimeFactor: number;
};

export type ProgressInfo = {
  phase: "loading" | "decoding" | "transcribing" | "done";
  message: string;
  pct?: number;          // 0–100, for the current phase
  device?: DeviceInfo;
  audioDuration?: number; // seconds of audio (known after decoding)
};

export type ProgressCallback = (info: ProgressInfo) => void;

let transcriberPromise: Promise<any> | null = null;
let cachedDeviceInfo: DeviceInfo | null = null;

export function getCachedDeviceInfo(): DeviceInfo | null {
  return cachedDeviceInfo;
}

export async function detectDeviceInfo(): Promise<DeviceInfo> {
  if (cachedDeviceInfo) return cachedDeviceInfo;
  const useGPU = await hasWebGPU();
  cachedDeviceInfo = useGPU
    ? { device: "webgpu", dtype: "fp16", label: "WebGPU · fp16", realtimeFactor: 10 }
    : { device: "wasm", dtype: "q8", label: "CPU · q8 (WASM)", realtimeFactor: 1.5 };
  return cachedDeviceInfo;
}

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export async function getTranscriber(onProgress?: ProgressCallback) {
  if (!transcriberPromise) {
    const info = await detectDeviceInfo();
    onProgress?.({
      phase: "loading",
      message: `Loading Whisper Tiny on ${info.label} (first time ~40MB)…`,
      pct: 0,
      device: info,
    });
    transcriberPromise = pipeline(
      "automatic-speech-recognition",
      "onnx-community/whisper-tiny_timestamped",
      {
        device: info.device,
        dtype: info.dtype,
        progress_callback: (data: any) => {
          if (data.status === "progress" && data.file?.endsWith(".onnx")) {
            onProgress?.({
              phase: "loading",
              message: `Downloading model… ${Math.round(data.progress)}%`,
              pct: data.progress,
              device: info,
            });
          } else if (data.status === "done") {
            onProgress?.({ phase: "loading", message: "Model loaded", pct: 100, device: info });
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
  onProgress?: ProgressCallback,
): Promise<TranscriptionResult> {
  const transcriber = await getTranscriber(onProgress);
  const device = await detectDeviceInfo();
  onProgress?.({ phase: "decoding", message: "Decoding audio…", pct: 0, device });
  const audio = await decodeAudioFromFile(file);
  const audioDuration = audio.length / 16000;
  onProgress?.({
    phase: "transcribing",
    message: "Transcribing…",
    pct: 0,
    device,
    audioDuration,
  });

  const output: any = await transcriber(audio, {
    return_timestamps: "word",
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  onProgress?.({ phase: "done", message: "Done", pct: 100, device, audioDuration });


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
