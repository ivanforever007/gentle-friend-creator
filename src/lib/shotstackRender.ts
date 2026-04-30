// Client-side orchestrator for Shotstack render flow:
// 1. Get signed upload URL → PUT video file directly to Shotstack
// 2. Poll until ingest hosts a public source URL
// 3. Submit render with caption clips
// 4. Poll render status until done → return final MP4 URL

import {
  createIngestUpload,
  getIngestSource,
  submitRender,
  getRenderStatus,
} from "@/server/shotstack.functions";
import type { CaptionStyle } from "./captionStyles";
import type { WordTiming } from "./transcribe";

export type ShotstackResolution = "sd" | "hd" | "1080" | "preview" | "mobile";

function buildCaptionLines(words: WordTiming[], style: CaptionStyle) {
  const lines: { text: string; start: number; length: number }[] = [];
  let cur: WordTiming[] = [];
  for (const w of words) {
    cur.push(w);
    if (/[.!?]$/.test(w.word) || cur.length >= style.maxWordsPerLine) {
      const text = cur.map((x) => (style.uppercase ? x.word.toUpperCase() : x.word)).join(" ");
      const start = cur[0].start;
      const length = Math.max(0.1, cur[cur.length - 1].end - start);
      lines.push({ text, start, length });
      cur = [];
    }
  }
  if (cur.length) {
    const text = cur.map((x) => (style.uppercase ? x.word.toUpperCase() : x.word)).join(" ");
    const start = cur[0].start;
    const length = Math.max(0.1, cur[cur.length - 1].end - start);
    lines.push({ text, start, length });
  }
  return lines;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function renderWithShotstack(opts: {
  videoFile: File;
  words: WordTiming[];
  style: CaptionStyle;
  resolution: ShotstackResolution;
  width: number;
  height: number;
  onProgress: (ratio: number) => void;
  onLog: (msg: string) => void;
}): Promise<{ url: string }> {
  const { videoFile, words, style, resolution, width, height, onProgress, onLog } = opts;

  onLog("Requesting upload URL…");
  onProgress(0.02);
  const { uploadUrl, sourceId } = await createIngestUpload();

  onLog(`Uploading video (${(videoFile.size / 1024 / 1024).toFixed(1)} MB)…`);
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    body: videoFile,
    headers: { "Content-Type": videoFile.type || "video/mp4" },
  });
  if (!putRes.ok) {
    throw new Error(`Upload to Shotstack failed [${putRes.status}]`);
  }
  onProgress(0.18);
  onLog("Upload complete. Waiting for ingest…");

  // Poll ingest until ready (status === "ready" with a source URL)
  let sourceUrl: string | null = null;
  for (let i = 0; i < 90; i++) {
    await delay(2000);
    const s = await getIngestSource({ data: { sourceId } });
    onLog(`Ingest: ${s.status}`);
    if (s.status === "ready" && s.sourceUrl) {
      sourceUrl = s.sourceUrl;
      break;
    }
    if (s.status === "failed") {
      throw new Error(`Ingest failed: ${s.error ?? "unknown"}`);
    }
    onProgress(0.18 + Math.min(0.15, i * 0.005));
  }
  if (!sourceUrl) throw new Error("Ingest timed out waiting for source");

  onProgress(0.35);
  onLog("Submitting render job…");

  const captions = buildCaptionLines(words, style);
  const fontSize = Math.max(20, Math.round(height * style.fontSizeRatio * 0.7));

  const { renderId } = await submitRender({
    data: {
      videoUrl: sourceUrl,
      width,
      height,
      resolution,
      captions,
      fontFamily: style.font,
      fontSize,
      fontColor: style.primary.length === 7 ? style.primary : "#FFFFFF",
      bold: style.bold,
      position: style.position,
    },
  });
  onLog(`Render queued: ${renderId}`);

  // Poll render status
  let finalUrl: string | null = null;
  for (let i = 0; i < 180; i++) {
    await delay(3000);
    const s = await getRenderStatus({ data: { renderId } });
    onLog(`Render: ${s.status}`);
    const stageMap: Record<string, number> = {
      queued: 0.4,
      fetching: 0.5,
      rendering: 0.75,
      saving: 0.92,
      done: 1,
    };
    if (stageMap[s.status]) onProgress(stageMap[s.status]);
    if (s.status === "done" && s.url) {
      finalUrl = s.url;
      break;
    }
    if (s.status === "failed") {
      throw new Error(`Render failed: ${s.error ?? "unknown"}`);
    }
  }
  if (!finalUrl) throw new Error("Render timed out");
  return { url: finalUrl };
}
