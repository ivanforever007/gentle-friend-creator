// FFmpeg.wasm renderer — burns ASS subtitles into the video and re-encodes.
// Uses the single-threaded core so it works without SharedArrayBuffer / COOP-COEP.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { CaptionStyle } from "./captionStyles";
import type { WordTiming } from "./transcribe";

const coreURL = "/ffmpeg/ffmpeg-core.js";
const wasmURL = "/ffmpeg/ffmpeg-core.wasm";

let ffmpeg: FFmpeg | null = null;
let loadingPromise: Promise<FFmpeg> | null = null;
let runtimeAssetPromise: Promise<{ coreURL: string; wasmURL: string }> | null = null;

function toError(err: unknown, fallback: string): Error {
  return err instanceof Error ? err : new Error(typeof err === "string" ? err : fallback);
}

async function getRuntimeAssetURLs() {
  if (runtimeAssetPromise) return runtimeAssetPromise;
  runtimeAssetPromise = Promise.all([
    toBlobURL(coreURL, "text/javascript"),
    toBlobURL(wasmURL, "application/wasm"),
  ])
    .then(([coreBlobURL, wasmBlobURL]) => ({
      coreURL: coreBlobURL,
      wasmURL: wasmBlobURL,
    }))
    .catch((err) => {
      runtimeAssetPromise = null;
      throw toError(err, "Failed to fetch FFmpeg runtime assets");
    });

  return runtimeAssetPromise;
}

export type Resolution = "720p" | "1080p" | "2k" | "4k" | "source";

const RES_HEIGHT: Record<Exclude<Resolution, "source">, number> = {
  "720p": 720,
  "1080p": 1080,
  "2k": 1440,
  "4k": 2160,
};

export type RenderedVideo = {
  blob: Blob;
  extension: "mp4" | "webm";
  mimeType: string;
  renderer: "native" | "ffmpeg";
};

export async function getFFmpeg(
  onLog?: (msg: string) => void,
): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const instance = new FFmpeg();
      instance.on("log", ({ message }) => {
        onLog?.(message);
      });
      onLog?.("Loading FFmpeg core (≈25MB, one-time)…");
      const runtimeAssets = await getRuntimeAssetURLs();
      // Load the single-threaded core from blob URLs built from same-origin assets.
      // This avoids worker import failures on preview/published hosts while keeping
      // the runtime local and free of CDN/CORS issues.
      await instance.load(runtimeAssets);
      ffmpeg = instance;
      onLog?.("FFmpeg ready");
      return instance;
    } catch (e) {
      loadingPromise = null;
      throw toError(e, "Failed to load FFmpeg core");
    }
  })();
  return loadingPromise;
}

// Reset the singleton — call after a fatal error so the next attempt re-loads cleanly.
export function resetFFmpeg() {
  try { ffmpeg?.terminate(); } catch {}
  ffmpeg = null;
  loadingPromise = null;
}

export async function renderCaptionedVideo(opts: {
  videoFile: File;
  assText: string;
  resolution: Resolution;
  sourceWidth: number;
  sourceHeight: number;
  onProgress?: (ratio: number) => void;
  onLog?: (msg: string) => void;
}): Promise<Blob> {
  const { videoFile, assText, resolution, sourceHeight, onProgress, onLog } = opts;
  const ff = await getFFmpeg(onLog);

  // Use safe ASCII filenames inside the ffmpeg virtual FS — libass and the
  // subtitles filter are picky about paths with spaces or unicode.
  const ext = (videoFile.name.match(/\.[a-z0-9]+$/i)?.[0] ?? ".mp4").toLowerCase();
  const inputName = `input${ext}`;
  const subName = "captions.ass";
  const outName = "output.mp4";

  // Clean any leftovers from a previous failed run.
  for (const f of [inputName, subName, outName]) {
    try { await ff.deleteFile(f); } catch {}
  }

  await ff.writeFile(inputName, await fetchFile(videoFile));
  await ff.writeFile(subName, new TextEncoder().encode(assText));

  // Determine output dimensions, preserving aspect ratio
  let scaleFilter = "";
  if (resolution !== "source") {
    const targetH = RES_HEIGHT[resolution];
    if (targetH !== sourceHeight) {
      // Force even dimensions for libx264. Drop lanczos flag — not always compiled in.
      scaleFilter = `scale=-2:${targetH}`;
    }
  }

  // Build filter chain — subtitles MUST come after scaling so font sizing matches output.
  // The filename has no special chars, so no escaping needed.
  const filters = [scaleFilter, `subtitles=${subName}`].filter(Boolean).join(",");

  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.max(0, Math.min(1, progress)));
  };
  ff.on("progress", progressHandler);

  // Try with audio first; fall back to video-only if the source has no audio track.
  const buildArgs = (includeAudio: boolean) => {
    const args = [
      "-i", inputName,
      "-vf", filters,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
    ];
    if (includeAudio) {
      args.push("-c:a", "aac", "-b:a", "192k");
    } else {
      args.push("-an");
    }
    args.push("-movflags", "+faststart", "-y", outName);
    return args;
  };

  let exitCode: number;
  try {
    exitCode = await ff.exec(buildArgs(true));
    if (exitCode !== 0) {
      onLog?.("Retrying without audio track…");
      try { await ff.deleteFile(outName); } catch {}
      exitCode = await ff.exec(buildArgs(false));
    }
  } catch (e) {
    ff.off("progress", progressHandler);
    resetFFmpeg();
    const err = toError(e, "FFmpeg crashed during render");
    throw new Error(
      "FFmpeg crashed during render. This often means the video is too large for the browser. " +
      "Try a shorter clip or a lower export resolution. " +
      `(${err.message})`,
    );
  }
  ff.off("progress", progressHandler);

  if (exitCode !== 0) {
    throw new Error(
      `FFmpeg exited with code ${exitCode}. Check the log panel for the underlying ffmpeg error ` +
      `(common causes: unsupported codec in source video, or audio track missing).`,
    );
  }

  let data: Uint8Array;
  try {
    data = (await ff.readFile(outName)) as Uint8Array;
  } catch {
    throw new Error("Render finished but output file is missing — see logs.");
  }
  if (!data || data.byteLength === 0) {
    throw new Error("Render produced an empty file — see logs.");
  }

  // Copy into a fresh ArrayBuffer to satisfy strict Blob typings
  const buf = new Uint8Array(data.byteLength);
  buf.set(data);
  const blob = new Blob([buf.buffer], { type: "video/mp4" });

  // Cleanup
  for (const f of [inputName, subName, outName]) {
    try { await ff.deleteFile(f); } catch {}
  }
  return blob;
}

function targetDimensions(
  resolution: Resolution,
  sourceWidth: number,
  sourceHeight: number,
) {
  if (resolution === "source") {
    return { width: makeEven(sourceWidth), height: makeEven(sourceHeight) };
  }

  const targetH = Math.min(RES_HEIGHT[resolution], sourceHeight || RES_HEIGHT[resolution]);
  const ratio = sourceWidth && sourceHeight ? sourceWidth / sourceHeight : 16 / 9;
  return {
    width: makeEven(Math.round(targetH * ratio)),
    height: makeEven(targetH),
  };
}

function makeEven(value: number) {
  const safe = Math.max(2, Math.round(value || 2));
  return safe % 2 === 0 ? safe : safe - 1;
}

function pickRecorderMimeType() {
  const options = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return options.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function captionLines(words: WordTiming[], style: CaptionStyle) {
  const lines: WordTiming[][] = [];
  let current: WordTiming[] = [];
  for (const word of words) {
    current.push(word);
    if (/[.!?]$/.test(word.word) || current.length >= style.maxWordsPerLine) {
      lines.push(current);
      current = [];
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

function hexToCanvasColor(hex: string | null | undefined) {
  if (!hex) return "transparent";
  const h = hex.replace("#", "");
  if (h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = parseInt(h.slice(6, 8), 16) / 255;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return hex;
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  items: { text: string; active: boolean }[],
  maxWidth: number,
) {
  const lines: { text: string; active: boolean }[][] = [[]];
  for (const item of items) {
    const current = lines[lines.length - 1];
    const test = [...current, item].map((part) => part.text).join(" ");
    if (current.length && ctx.measureText(test).width > maxWidth) {
      lines.push([item]);
    } else {
      current.push(item);
    }
  }
  return lines;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export async function renderCaptionedVideoNative(opts: {
  videoFile: File;
  words: WordTiming[];
  style: CaptionStyle;
  resolution: Resolution;
  sourceWidth: number;
  sourceHeight: number;
  onProgress?: (ratio: number) => void;
  onLog?: (msg: string) => void;
}): Promise<RenderedVideo> {
  const { videoFile, words, style, resolution, sourceWidth, sourceHeight, onProgress, onLog } = opts;
  if (!("MediaRecorder" in window)) throw new Error("This browser cannot record video exports.");
  const mimeType = pickRecorderMimeType();
  if (!mimeType) throw new Error("This browser has no supported video recorder format.");

  const { width, height } = targetDimensions(resolution, sourceWidth, sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not start the video canvas renderer.");

  const video = document.createElement("video");
  const sourceUrl = URL.createObjectURL(videoFile);
  video.src = sourceUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Could not read this video file."));
  });

  const stream = canvas.captureStream(30);
  let audioContext: AudioContext | null = null;
  try {
    const AudioCtx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    audioContext = new AudioCtx();
    const audioSource = audioContext.createMediaElementSource(video);
    const audioDestination = audioContext.createMediaStreamDestination();
    audioSource.connect(audioDestination);
    for (const track of audioDestination.stream.getAudioTracks()) stream.addTrack(track);
  } catch {
    onLog?.("Exporting without source audio track…");
  }
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: resolution === "4k" ? 12_000_000 : resolution === "2k" ? 8_000_000 : 5_000_000,
  });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const lines = captionLines(words, style);
  const duration = video.duration || Math.max(...words.map((word) => word.end), 0);
  let animationFrame = 0;
  let stopped = false;
  onLog?.("Using reliable browser recorder export…");

  const drawFrame = () => {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(video, 0, 0, width, height);

    const currentTime = video.currentTime;
    const activeLine = lines.find(
      (line) => line.length && currentTime >= line[0].start - 0.05 && currentTime <= line[line.length - 1].end + 0.05,
    );

    if (activeLine) {
      drawCaption(ctx, activeLine, style, currentTime, width, height);
    }

    onProgress?.(duration ? Math.min(0.99, currentTime / duration) : 0);
    if (!stopped && !video.ended) animationFrame = requestAnimationFrame(drawFrame);
  };

  const finished = new Promise<RenderedVideo>((resolve, reject) => {
    recorder.onerror = () => reject(new Error("The browser recorder failed while exporting."));
    recorder.onstop = () => {
      URL.revokeObjectURL(sourceUrl);
      audioContext?.close().catch(() => {});
      if (!chunks.length) {
        reject(new Error("Export finished but no video data was created."));
        return;
      }
      const blob = new Blob(chunks, { type: mimeType || "video/webm" });
      resolve({ blob, extension: "webm", mimeType: blob.type, renderer: "native" });
    };
  });

  video.onended = () => {
    stopped = true;
    cancelAnimationFrame(animationFrame);
    drawFrame();
    onProgress?.(1);
    if (recorder.state !== "inactive") recorder.stop();
  };

  if (audioContext?.state === "suspended") await audioContext.resume().catch(() => {});
  recorder.start(1000);
  drawFrame();
  await video.play();
  return finished;
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  line: WordTiming[],
  style: CaptionStyle,
  currentTime: number,
  width: number,
  height: number,
) {
  const fontSize = Math.max(14, Math.round(height * style.fontSizeRatio));
  const family = style.font.includes(" ") ? `"${style.font}"` : style.font;
  ctx.font = `${style.italic ? "italic " : ""}${style.bold ? "900" : "500"} ${fontSize}px ${family}, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  const words = line.map((word) => ({
    text: style.uppercase ? word.word.toUpperCase() : word.word,
    active: currentTime >= word.start && currentTime <= word.end,
  }));
  const maxTextWidth = width * 0.9;
  const wrapped = wrapCanvasText(ctx, words, maxTextWidth);
  const lineHeight = fontSize * 1.18;
  const blockHeight = wrapped.length * lineHeight;
  const centerY =
    style.position === "bottom"
      ? height - height * style.marginV - blockHeight / 2
      : style.position === "top"
        ? height * style.marginV + blockHeight / 2
        : height / 2;
  const startY = centerY - blockHeight / 2 + lineHeight / 2;

  if (style.bg) {
    const widest = Math.max(...wrapped.map((parts) => ctx.measureText(parts.map((part) => part.text).join(" ")).width));
    const padX = Math.max(10, style.bgPadding * (height / 720));
    const padY = Math.max(6, padX * 0.55);
    drawRoundedRect(
      ctx,
      width / 2 - widest / 2 - padX,
      centerY - blockHeight / 2 - padY,
      widest + padX * 2,
      blockHeight + padY * 2,
      Math.max(6, padX * 0.65),
    );
    ctx.fillStyle = hexToCanvasColor(style.bg);
    ctx.fill();
  }

  wrapped.forEach((parts, lineIndex) => {
    const totalWidth = ctx.measureText(parts.map((part) => part.text).join(" ")).width;
    let x = width / 2 - totalWidth / 2;
    const y = startY + lineIndex * lineHeight;
    parts.forEach((part, index) => {
      const prefix = index === 0 ? "" : " ";
      const text = `${prefix}${part.text}`;
      const metrics = ctx.measureText(text);
      const drawX = x + metrics.width / 2;
      ctx.strokeStyle = style.outline;
      ctx.lineWidth = style.bg ? 0 : Math.max(0, style.outlineWidth * (height / 720));
      if (style.shadow && !style.bg) {
        ctx.shadowColor = "rgba(0,0,0,0.65)";
        ctx.shadowBlur = style.shadow * (height / 360);
        ctx.shadowOffsetY = style.shadow * (height / 720);
      }
      if (ctx.lineWidth > 0) ctx.strokeText(text, drawX, y);
      ctx.shadowColor = "transparent";
      ctx.fillStyle = style.highlightMode !== "none" && part.active ? style.highlight : style.primary;
      ctx.fillText(text, drawX, y);
      x += metrics.width;
    });
  });
}

export async function renderCaptionedVideoReliable(opts: {
  videoFile: File;
  assText: string;
  words: WordTiming[];
  style: CaptionStyle;
  resolution: Resolution;
  sourceWidth: number;
  sourceHeight: number;
  onProgress?: (ratio: number) => void;
  onLog?: (msg: string) => void;
}): Promise<RenderedVideo> {
  try {
    return await renderCaptionedVideoNative(opts);
  } catch (error) {
    opts.onLog?.(`Browser recorder failed; trying MP4 renderer. ${toError(error, "Unknown error").message}`);
    opts.onProgress?.(0);
    const blob = await renderCaptionedVideo(opts);
    return { blob, extension: "mp4", mimeType: "video/mp4", renderer: "ffmpeg" };
  }
}
