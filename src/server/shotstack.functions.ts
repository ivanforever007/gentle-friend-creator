// Shotstack server functions — handle video ingest + render with burned-in captions.
// Uses the Stage (sandbox) environment by default for free testing.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const SHOTSTACK_HOST = "https://api.shotstack.io";
// Use stage (sandbox) — free + matches the sandbox key the user pastes from dashboard.
const ENV = "stage";

function apiKey() {
  const k = process.env.SHOTSTACK_API_KEY;
  if (!k) throw new Error("SHOTSTACK_API_KEY is not configured on the server");
  return k;
}

// 1. Get a signed upload URL from Shotstack ingest, the client PUTs the file directly to it.
export const createIngestUpload = createServerFn({ method: "POST" })
  .handler(async () => {
    const res = await fetch(`${SHOTSTACK_HOST}/ingest/${ENV}/upload`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey(),
        "Content-Type": "application/json",
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Shotstack ingest failed [${res.status}]: ${text}`);
    }
    const json = JSON.parse(text) as {
      data: {
        attributes: { url: string; id: string };
      };
    };
    return {
      uploadUrl: json.data.attributes.url,
      sourceId: json.data.attributes.id,
    };
  });

// 2. Poll the ingest source until it has a hosted public URL we can pass to render.
export const getIngestSource = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ sourceId: z.string().min(1).max(200) }).parse(d))
  .handler(async ({ data }) => {
    const res = await fetch(`${SHOTSTACK_HOST}/ingest/${ENV}/sources/${data.sourceId}`, {
      headers: { "x-api-key": apiKey() },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Shotstack source lookup failed [${res.status}]: ${text}`);
    const json = JSON.parse(text) as {
      data: { attributes: { status: string; source?: string; error?: string } };
    };
    return {
      status: json.data.attributes.status,
      sourceUrl: json.data.attributes.source ?? null,
      error: json.data.attributes.error ?? null,
    };
  });

// Caption line we send to Shotstack: each becomes an HTML title clip overlaid on the video.
const CaptionLine = z.object({
  text: z.string().min(1).max(500),
  start: z.number().min(0).max(36000),
  length: z.number().min(0.05).max(600),
});

const RenderInput = z.object({
  videoUrl: z.string().url().max(2000),
  width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096),
  resolution: z.enum(["sd", "hd", "1080", "preview", "mobile"]),
  captions: z.array(CaptionLine).min(1).max(2000),
  // Style — kept simple/safe for the API
  fontFamily: z.string().min(1).max(80),
  fontSize: z.number().int().min(8).max(200),
  fontColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  bold: z.boolean(),
  position: z.enum(["top", "center", "bottom"]),
});

// 3. Submit the render job. Captions are burned in by overlaying HTML title clips.
export const submitRender = createServerFn({ method: "POST" })
  .inputValidator((d) => RenderInput.parse(d))
  .handler(async ({ data }) => {
    const weight = data.bold ? 800 : 600;
    const yOffset = data.position === "top" ? 0.38 : data.position === "center" ? 0 : -0.38;

    // Map our resolution choice → Shotstack output size (Shotstack supports sd/hd/1080).
    const captionClips = data.captions.map((c) => ({
      asset: {
        type: "html",
        html: `<p>${escapeHtml(c.text)}</p>`,
        css: `p { color: ${data.fontColor}; font-family: '${data.fontFamily}'; font-size: ${data.fontSize}px; font-weight: ${weight}; text-align: center; line-height: 1.2; text-shadow: 0 2px 4px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.6); margin: 0; padding: 12px 24px; }`,
        width: Math.min(1200, Math.round(data.width * 0.92)),
        height: Math.max(80, Math.round(data.fontSize * 3.5)),
      },
      start: c.start,
      length: c.length,
      offset: { x: 0, y: yOffset },
      transition: { in: "fade", out: "fade" },
    }));

    const payload = {
      timeline: {
        background: "#000000",
        tracks: [
          { clips: captionClips },
          {
            clips: [
              {
                asset: { type: "video", src: data.videoUrl },
                start: 0,
                length: "auto",
              },
            ],
          },
        ],
      },
      output: {
        format: "mp4",
        resolution: data.resolution,
        fps: 30,
      },
    };

    const res = await fetch(`${SHOTSTACK_HOST}/edit/${ENV}/render`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Shotstack render submit failed [${res.status}]: ${text}`);
    const json = JSON.parse(text) as { response: { id: string } };
    return { renderId: json.response.id };
  });

// 4. Poll render status until we get a final URL.
export const getRenderStatus = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ renderId: z.string().min(1).max(200) }).parse(d))
  .handler(async ({ data }) => {
    const res = await fetch(`${SHOTSTACK_HOST}/edit/${ENV}/render/${data.renderId}`, {
      headers: { "x-api-key": apiKey() },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Shotstack status failed [${res.status}]: ${text}`);
    const json = JSON.parse(text) as {
      response: { status: string; url?: string; error?: string };
    };
    return {
      status: json.response.status, // queued | fetching | rendering | saving | done | failed
      url: json.response.url ?? null,
      error: json.response.error ?? null,
    };
  });

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
