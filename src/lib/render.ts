// FFmpeg.wasm renderer — burns ASS subtitles into the video and re-encodes.
// Singleton ffmpeg instance to avoid re-loading the ~30MB core.

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
    const instance = new FFmpeg();
    instance.on("log", ({ message }) => {
      onLog?.(message);
    });
    onLog?.("Loading FFmpeg core (≈30MB, one-time)…");
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
    await instance.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpeg = instance;
    onLog?.("FFmpeg ready");
    return instance;
  })();
  return loadingPromise;
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
  const { videoFile, assText, resolution, sourceWidth, sourceHeight, onProgress, onLog } = opts;
  const ff = await getFFmpeg(onLog);

  const inputName = "input" + (videoFile.name.match(/\.[a-z0-9]+$/i)?.[0] ?? ".mp4");
  const subName = "captions.ass";
  const outName = "output.mp4";

  await ff.writeFile(inputName, await fetchFile(videoFile));
  await ff.writeFile(subName, new TextEncoder().encode(assText));

  // Determine output dimensions, preserving aspect ratio
  let scaleFilter = "";
  if (resolution !== "source") {
    const targetH = RES_HEIGHT[resolution];
    if (targetH !== sourceHeight) {
      // Scale by height, preserve aspect, force even dimensions
      scaleFilter = `scale=-2:${targetH}`;
    }
  }

  // Build filter chain — subtitles MUST come after scaling so font sizing matches output
  const filters = [scaleFilter, `subtitles=${subName}`].filter(Boolean).join(",");

  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.max(0, Math.min(1, progress)));
  };
  ff.on("progress", progressHandler);

  try {
    await ff.exec([
      "-i", inputName,
      "-vf", filters,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      outName,
    ]);
  } finally {
    ff.off("progress", progressHandler);
  }

  const data = await ff.readFile(outName);
  const blob = new Blob([data as Uint8Array], { type: "video/mp4" });
  // Cleanup
  try {
    await ff.deleteFile(inputName);
    await ff.deleteFile(subName);
    await ff.deleteFile(outName);
  } catch {}
  return blob;
}

// Reference unused vars to satisfy TS strict if needed
void [sourceWidthMarker];
const sourceWidthMarker = 0;
