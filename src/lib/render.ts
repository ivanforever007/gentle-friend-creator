// FFmpeg.wasm renderer — burns ASS subtitles into the video and re-encodes.
// Uses the single-threaded core so it works without SharedArrayBuffer / COOP-COEP.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;
let loadingPromise: Promise<FFmpeg> | null = null;

export type Resolution = "720p" | "1080p" | "2k" | "4k" | "source";

const RES_HEIGHT: Record<Exclude<Resolution, "source">, number> = {
  "720p": 720,
  "1080p": 1080,
  "2k": 1440,
  "4k": 2160,
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
      // Single-threaded core — no SharedArrayBuffer required, works on any host.
      const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
      await instance.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
      });
      ffmpeg = instance;
      onLog?.("FFmpeg ready");
      return instance;
    } catch (e) {
      loadingPromise = null;
      throw e;
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
      scaleFilter = `scale=-2:${targetH}:flags=lanczos`;
    }
  }

  // Build filter chain — subtitles MUST come after scaling so font sizing matches output.
  // The filename has no special chars, so no escaping needed.
  const filters = [scaleFilter, `subtitles=${subName}`].filter(Boolean).join(",");

  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.max(0, Math.min(1, progress)));
  };
  ff.on("progress", progressHandler);

  let exitCode: number;
  try {
    exitCode = await ff.exec([
      "-i", inputName,
      "-vf", filters,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-y",
      outName,
    ]);
  } catch (e) {
    ff.off("progress", progressHandler);
    resetFFmpeg();
    throw new Error(
      "FFmpeg crashed during render. This often means the video is too large for the browser. " +
      "Try a shorter clip or a lower export resolution. " +
      `(${e instanceof Error ? e.message : String(e)})`,
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
