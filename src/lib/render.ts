// FFmpeg.wasm renderer — burns ASS subtitles into the video and re-encodes.
// Uses the single-threaded core so it works without SharedArrayBuffer / COOP-COEP.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import coreURL from "@ffmpeg/core/dist/umd/ffmpeg-core.js?url";
import wasmURL from "@ffmpeg/core/dist/umd/ffmpeg-core.wasm?url";

let ffmpeg: FFmpeg | null = null;
let loadingPromise: Promise<FFmpeg> | null = null;

function toError(err: unknown, fallback: string): Error {
  return err instanceof Error ? err : new Error(typeof err === "string" ? err : fallback);
}

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
      // Load the single-threaded core from same-origin bundled assets.
      // This avoids production CDN/CORS failures like “failed to import ffmpeg-core.js”.
      await instance.load({ coreURL, wasmURL });
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
