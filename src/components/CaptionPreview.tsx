import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import type { CaptionStyle } from "@/lib/captionStyles";
import type { WordTiming } from "@/lib/transcribe";

type Props = {
  videoUrl: string | null;
  words: WordTiming[];
  style: CaptionStyle;
  className?: string;
};

// Live preview overlay — renders captions in HTML over the <video> in real-time.
// Mirrors the ASS render closely enough for stylistic preview.
export function CaptionPreview({ videoUrl, words, style, className }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [t, setT] = useState(0);
  const [containerH, setContainerH] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setT(v.currentTime);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeked", onTime);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeked", onTime);
    };
  }, [videoUrl]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerH(e.contentRect.height);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const [isFs, setIsFs] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFs = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch (e) {
      console.error("Fullscreen failed", e);
    }
  }, []);

  // Group into lines exactly like ASS builder
  const lines = useMemo(() => {
    const ls: WordTiming[][] = [];
    let cur: WordTiming[] = [];
    for (const w of words) {
      cur.push(w);
      const isBreak = /[.!?]$/.test(w.word) || cur.length >= style.maxWordsPerLine;
      if (isBreak) { ls.push(cur); cur = []; }
    }
    if (cur.length) ls.push(cur);
    return ls;
  }, [words, style.maxWordsPerLine]);

  const activeLine = useMemo(() => {
    return lines.find((l) => l.length && t >= l[0].start - 0.05 && t <= l[l.length - 1].end + 0.05);
  }, [lines, t]);

  const fontSize = Math.max(10, Math.round((containerH || 360) * style.fontSizeRatio));
  const positionStyle: React.CSSProperties =
    style.position === "bottom"
      ? { bottom: `${style.marginV * 100}%`, top: "auto" }
      : style.position === "top"
        ? { top: `${style.marginV * 100}%`, bottom: "auto" }
        : { top: "50%", transform: "translate(-50%, -50%)" };

  const textShadow = `${style.outlineWidth}px 0 0 ${style.outline}, -${style.outlineWidth}px 0 0 ${style.outline}, 0 ${style.outlineWidth}px 0 ${style.outline}, 0 -${style.outlineWidth}px 0 ${style.outline}, ${style.outlineWidth}px ${style.outlineWidth}px 0 ${style.outline}, -${style.outlineWidth}px -${style.outlineWidth}px 0 ${style.outline}, ${style.outlineWidth}px -${style.outlineWidth}px 0 ${style.outline}, -${style.outlineWidth}px ${style.outlineWidth}px 0 ${style.outline}${style.shadow ? `, 0 ${style.shadow}px ${style.shadow * 2}px rgba(0,0,0,0.6)` : ""}`;

  return (
    <div ref={containerRef} className={"group relative w-full overflow-hidden rounded-xl bg-black " + (className ?? "")}>
      {videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          playsInline
          controlsList="nofullscreen"
          disablePictureInPicture
          className="block h-full w-full"
        />
      ) : (
        <div className="flex aspect-video items-center justify-center text-muted-foreground">
          Upload a video to preview
        </div>
      )}

      {activeLine && (
        <div
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 px-4 text-center"
          style={{
            ...positionStyle,
            maxWidth: "90%",
          }}
        >
          <span
            style={{
              display: "inline-block",
              padding: style.bg ? `${style.bgPadding * 0.5}px ${style.bgPadding}px` : 0,
              backgroundColor: style.bg ?? "transparent",
              borderRadius: style.bg ? 8 : 0,
              fontFamily: `${style.font}, system-ui, sans-serif`,
              fontWeight: style.bold ? 900 : 500,
              fontStyle: style.italic ? "italic" : "normal",
              textTransform: style.uppercase ? "uppercase" : "none",
              letterSpacing: style.letterSpacing,
              fontSize,
              lineHeight: 1.15,
              color: style.primary,
              textShadow: style.bg ? "none" : textShadow,
            }}
          >
            {activeLine.map((w, i) => {
              const isActive = t >= w.start && t <= w.end;
              const highlighted = style.highlightMode !== "none" && isActive;
              const isLast = i === activeLine.length - 1;
              return (
                <span key={i} style={{ whiteSpace: "pre" }}>
                  <span
                    style={{
                      color: highlighted ? style.highlight : style.primary,
                      display: "inline-block",
                      transform: highlighted && (style.anim === "pop" || style.anim === "bounce") ? "scale(1.12)" : "scale(1)",
                      transformOrigin: "center",
                      transitionProperty: "color, transform",
                      transitionDuration: "120ms",
                    }}
                  >
                    {w.word}
                  </span>
                  {!isLast && "\u00A0"}
                </span>
              );
            })}
          </span>
        </div>
      )}

      {videoUrl && (
        <button
          type="button"
          onClick={toggleFs}
          aria-label={isFs ? "Exit fullscreen" : "Enter fullscreen"}
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-lg bg-black/60 text-white opacity-0 backdrop-blur transition-opacity hover:bg-black/80 group-hover:opacity-100 focus:opacity-100"
        >
          {isFs ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      )}
    </div>
  );
}
