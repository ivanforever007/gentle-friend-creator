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

export async function getTranscriber(
  onProgress?: (msg: string, pct?: number) => void,
) {
  if (!transcriberPromise) {
    onProgress?.("Loading Whisper model (first time ~75MB)…", 0);
    transcriberPromise = pipeline(
      "automatic-speech-recognition",
      "onnx-community/whisper-base_timestamped",
      {
        device: (navigator as any).gpu ? "webgpu" : "wasm",
        dtype: "q8",
        progress_callback: (data: any) => {
          if (data.status === "progress" && data.file?.endsWith(".onnx")) {
            onProgress?.(`Downloading model… ${Math.round(data.progress)}%`, data.progress);
          } else if (data.status === "done") {
            onProgress?.("Model loaded", 100);
          }
        },
      } as any,
    );
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
  buf.copyToChannel(audio, 0);
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
  const transcriber = await getTranscriber(onProgress);
  onProgress?.("Decoding audio…", 0);
  const audio = await decodeAudioFromFile(file);
  onProgress?.("Transcribing… (this can take a minute)", 0);

  const output: any = await transcriber(audio, {
    return_timestamps: "word",
    chunk_length_s: 30,
    stride_length_s: 5,
  });

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
