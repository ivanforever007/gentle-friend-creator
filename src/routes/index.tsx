import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Upload, Sparkles, Download, Wand2, Film, Loader2, Type, Palette, Zap, Cpu, Gauge, Timer } from "lucide-react";

import { CAPTION_STYLES, type CaptionStyle } from "@/lib/captionStyles";
import { transcribeFile, detectDeviceInfo, type WordTiming, type DeviceInfo, type ProgressInfo } from "@/lib/transcribe";
import { buildAss } from "@/lib/assBuilder";
import { renderCaptionedVideoReliable, type RenderedVideo, type Resolution } from "@/lib/render";
import { StylePicker } from "@/components/StylePicker";
import { StyleControls } from "@/components/StyleControls";
import { CaptionPreview } from "@/components/CaptionPreview";

export const Route = createFileRoute("/")({
  component: HomePage,
  // Client-only: this page uses URL.createObjectURL, FFmpeg.wasm, and Whisper —
  // none of which work during SSR. Disabling SSR avoids hydration mismatches (React #419).
  ssr: false,
  head: () => ({
    meta: [
      { title: "AutoCaption — Pro Word-Accurate Captions, 20 Viral Styles" },
      { name: "description", content: "Upload any video, get pixel-perfect, word-timed captions in 20 social-first styles. Export 720p, 1080p, 2K or 4K — runs entirely in your browser." },
      { property: "og:title", content: "AutoCaption — Word-Accurate Captions" },
      { property: "og:description", content: "20 viral caption styles. Word-level timing. Export up to 4K." },
    ],
  }),
});

type Stage = "idle" | "transcribing" | "ready" | "rendering" | "done";

function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoDims, setVideoDims] = useState<{ w: number; h: number }>({ w: 1080, h: 1920 });
  const [words, setWords] = useState<WordTiming[]>([]);
  const [style, setStyle] = useState<CaptionStyle>(CAPTION_STYLES[0]);
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputMeta, setOutputMeta] = useState<Pick<RenderedVideo, "extension" | "renderer"> | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [phase, setPhase] = useState<ProgressInfo["phase"] | null>(null);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [transcribeStartedAt, setTranscribeStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Tick once a second while transcribing so ETA updates live.
  useMemo(() => {
    if (typeof window === "undefined") return;
    if (stage !== "transcribing") return;
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [stage]);

  // Detect device on mount so we can show it before transcription starts.
  if (typeof window !== "undefined" && device === null) {
    detectDeviceInfo().then((d) => setDevice((prev) => prev ?? d)).catch(() => {});
  }


  const onFile = useCallback(async (f: File) => {
    if (!f.type.startsWith("video/")) {
      toast.error("Please upload a video file");
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (outputUrl) { URL.revokeObjectURL(outputUrl); setOutputUrl(null); setOutputMeta(null); }
    const url = URL.createObjectURL(f);
    setFile(f);
    setVideoUrl(url);
    setWords([]);
    setStage("idle");
    setProgress(0);

    // Probe dimensions
    const probe = document.createElement("video");
    probe.src = url;
    probe.muted = true;
    probe.preload = "metadata";
    await new Promise<void>((res) => {
      probe.onloadedmetadata = () => res();
      probe.onerror = () => res();
    });
    if (probe.videoWidth && probe.videoHeight) {
      setVideoDims({ w: probe.videoWidth, h: probe.videoHeight });
    }
  }, [videoUrl, outputUrl]);

  const handleTranscribe = useCallback(async () => {
    if (!file) return;
    try {
      setStage("transcribing");
      setProgress(5);
      setStatusMsg("Loading model…");
      const result = await transcribeFile(file, (msg, pct) => {
        setStatusMsg(msg);
        if (typeof pct === "number") setProgress(Math.max(5, Math.min(95, pct)));
      });
      if (!result.words.length) {
        toast.error("No speech detected in this video");
        setStage("idle");
        return;
      }
      setWords(result.words);
      setStage("ready");
      setProgress(100);
      setStatusMsg(`Transcribed ${result.words.length} words`);
      toast.success(`Detected ${result.words.length} words`);
    } catch (e) {
      console.error(e);
      toast.error("Transcription failed", { description: e instanceof Error ? e.message : "Unknown error" });
      setStage("idle");
    }
  }, [file]);

  const handleRender = useCallback(async () => {
    if (!file || !words.length) return;
    try {
      setStage("rendering");
      setProgress(0);
      setStatusMsg("Preparing renderer…");
      setLogs([]);
      if (outputUrl) { URL.revokeObjectURL(outputUrl); setOutputUrl(null); setOutputMeta(null); }

      const ass = buildAss(words, style, videoDims.w, videoDims.h);

      const rendered = await renderCaptionedVideoReliable({
        videoFile: file,
        assText: ass,
        words,
        style,
        resolution,
        sourceWidth: videoDims.w,
        sourceHeight: videoDims.h,
        onProgress: (r) => {
          setProgress(Math.round(r * 100));
          setStatusMsg(`Rendering… ${Math.round(r * 100)}%`);
        },
        onLog: (m) => setLogs((prev) => [...prev.slice(-50), m]),
      });

      const url = URL.createObjectURL(rendered.blob);
      setOutputUrl(url);
      setOutputMeta({ extension: rendered.extension, renderer: rendered.renderer });
      setStage("done");
      setStatusMsg("Done!");
      toast.success("Video ready to download", {
        description: rendered.renderer === "native" ? "Used fallback exporter with burned-in captions." : undefined,
      });
    } catch (e) {
      console.error(e);
      toast.error("Render failed", { description: e instanceof Error ? e.message : "Unknown error" });
      setStage("ready");
    }
  }, [file, words, style, videoDims, resolution, outputUrl]);

  const downloadName = useMemo(() => {
    const base = file?.name.replace(/\.[^.]+$/, "") ?? "captioned";
    return `${base}-${style.id}-${resolution}.${outputMeta?.extension ?? "mp4"}`;
  }, [file, style.id, resolution, outputMeta?.extension]);

  return (
    <div className="min-h-screen bg-background bg-gradient-glow">
      <Toaster theme="dark" position="top-center" richColors />

      <header className="border-b border-border/50 bg-background/60 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 md:px-8">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-hero shadow-glow">
              <Sparkles className="h-4.5 w-4.5 text-background" />
            </div>
            <div>
              <div className="font-display text-lg font-bold leading-none tracking-tight">AutoCaption</div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Word-Accurate · 20 Styles · 4K</div>
            </div>
          </div>
          <div className="hidden items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground md:flex">
            <Zap className="h-3 w-3 text-accent" />
            100% in-browser · zero upload to servers
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 md:px-8 md:py-12">
        {!file && (
          <section className="mb-10 text-center">
            <h1 className="mx-auto max-w-3xl font-display text-4xl font-bold tracking-tight md:text-6xl">
              Pro captions in <span className="text-gradient">20 viral styles</span>.
              <br className="hidden md:block" />
              Word-perfect timing. Up to 4K.
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground md:text-lg">
              Upload any video — Whisper AI runs locally for surgical word-level timing.
              Pick a style, fine-tune everything, export ready for TikTok, Reels &amp; Shorts.
            </p>
          </section>
        )}

        {!file ? (
          <DropZone onFile={onFile} inputRef={inputRef} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
            {/* LEFT: Preview + Style picker */}
            <div className="space-y-6">
              <Card className="overflow-hidden border-border/60 bg-gradient-card p-0 shadow-elevated">
                <CaptionPreview
                  videoUrl={videoUrl}
                  words={words}
                  style={style}
                  className="aspect-video"
                />
              </Card>

              {stage === "transcribing" || stage === "rendering" ? (
                <Card className="border-primary/40 bg-gradient-card p-5 shadow-glow">
                  <div className="mb-3 flex items-center gap-3">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    <div className="flex-1">
                      <div className="text-sm font-semibold">{stage === "transcribing" ? "Transcribing audio" : "Rendering video"}</div>
                      <div className="text-xs text-muted-foreground">{statusMsg}</div>
                    </div>
                    <div className="font-mono text-sm text-primary">{progress}%</div>
                  </div>
                  <Progress value={progress} className="h-2" />
                </Card>
              ) : null}

              <div>
                <div className="mb-3 flex items-center gap-2">
                  <Palette className="h-4 w-4 text-accent" />
                  <h2 className="font-display text-lg font-bold">Pick a style</h2>
                  <span className="text-xs text-muted-foreground">· 20 social-first designs</span>
                </div>
                <StylePicker selectedId={style.id} onSelect={setStyle} />
              </div>
            </div>

            {/* RIGHT: Action panel */}
            <aside className="space-y-4">
              <Card className="border-border/60 bg-gradient-card p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="font-display text-sm font-bold">{file.name}</div>
                    <div className="text-xs text-muted-foreground">{videoDims.w}×{videoDims.h} · {(file.size / 1024 / 1024).toFixed(1)}MB</div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => inputRef.current?.click()}>Change</Button>
                </div>

                {words.length === 0 ? (
                  <Button
                    onClick={handleTranscribe}
                    disabled={stage === "transcribing"}
                    className="h-12 w-full bg-gradient-hero font-bold text-background shadow-glow hover:opacity-90"
                    size="lg"
                  >
                    {stage === "transcribing" ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Transcribing…</>
                    ) : (
                      <><Wand2 className="mr-2 h-4 w-4" /> Generate Captions</>
                    )}
                  </Button>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 p-2.5 text-xs text-accent-foreground">
                      <Type className="h-3.5 w-3.5 text-accent" />
                      <span><b>{words.length}</b> words detected · <b>{(words[words.length-1]?.end ?? 0).toFixed(1)}s</b></span>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Export resolution</label>
                      <Select value={resolution} onValueChange={(v) => setResolution(v as Resolution)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="720p">720p HD</SelectItem>
                          <SelectItem value="1080p">1080p Full HD</SelectItem>
                          <SelectItem value="2k">2K QHD (1440p)</SelectItem>
                          <SelectItem value="4k">4K UHD (2160p)</SelectItem>
                          <SelectItem value="source">Source ({videoDims.h}p)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <Button
                      onClick={handleRender}
                      disabled={stage === "rendering"}
                      className="h-12 w-full bg-gradient-hero font-bold text-background shadow-glow hover:opacity-90"
                      size="lg"
                    >
                      {stage === "rendering" ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Rendering…</>
                      ) : (
                        <><Film className="mr-2 h-4 w-4" /> Render &amp; Export</>
                      )}
                    </Button>

                    {outputUrl && (
                      <a href={outputUrl} download={downloadName} className="block">
                        <Button variant="secondary" className="h-12 w-full font-bold" size="lg">
                          <Download className="mr-2 h-4 w-4" /> Download {outputMeta?.extension?.toUpperCase() ?? "Video"}
                        </Button>
                      </a>
                    )}
                  </div>
                )}
              </Card>

              {words.length > 0 && (
                <Card className="border-border/60 bg-gradient-card p-5">
                  <Tabs defaultValue="design">
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="design">Design</TabsTrigger>
                      <TabsTrigger value="transcript">Transcript</TabsTrigger>
                    </TabsList>
                    <TabsContent value="design" className="pt-4">
                      <StyleControls style={style} onChange={setStyle} />
                    </TabsContent>
                    <TabsContent value="transcript" className="pt-4">
                      <div className="max-h-96 space-y-1 overflow-y-auto rounded-lg border border-border bg-background/50 p-3 text-sm leading-relaxed">
                        {words.map((w, i) => (
                          <span key={i} className="text-foreground/90">
                            {w.word}{" "}
                          </span>
                        ))}
                      </div>
                    </TabsContent>
                  </Tabs>
                </Card>
              )}

              {logs.length > 0 && stage === "rendering" && (
                <Card className="max-h-32 overflow-y-auto border-border/60 bg-black/50 p-3 font-mono text-[10px] leading-tight text-muted-foreground">
                  {logs.slice(-8).map((l, i) => <div key={i} className="truncate">{l}</div>)}
                </Card>
              )}
            </aside>
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
      </main>
    </div>
  );
}

function DropZone({ onFile, inputRef }: { onFile: (f: File) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [drag, setDrag] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      onClick={() => inputRef.current?.click()}
      className={
        "group mx-auto flex max-w-3xl cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed p-12 text-center transition-all md:p-20 " +
        (drag ? "border-primary bg-primary/5 shadow-glow" : "border-border bg-card/30 hover:border-primary/60 hover:bg-card/50")
      }
    >
      <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-hero shadow-glow transition-transform group-hover:scale-110">
        <Upload className="h-9 w-9 text-background" strokeWidth={2.5} />
      </div>
      <h2 className="font-display text-2xl font-bold md:text-3xl">Drop your video here</h2>
      <p className="mt-2 text-sm text-muted-foreground md:text-base">
        Any length, any format · MP4, MOV, WebM, MKV — all processed locally
      </p>
      <Button className="mt-6 h-12 bg-gradient-hero px-8 font-bold text-background shadow-glow hover:opacity-90">
        Choose video
      </Button>
    </div>
  );
}
