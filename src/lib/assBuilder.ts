// Build an Advanced SubStation Alpha (.ass) file from word-timings + style.
// Designed to look great when burned in via FFmpeg's `subtitles` filter (libass).

import type { CaptionStyle } from "./captionStyles";
import type { WordTiming } from "./transcribe";

function fmtTime(t: number): string {
  if (t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

// hex (#RRGGBB or #RRGGBBAA) -> ASS &HAABBGGRR
function hexToAss(hex: string): string {
  let h = hex.replace("#", "");
  if (h.length === 6) h = h + "FF";
  if (h.length === 8) {
    const r = h.slice(0, 2);
    const g = h.slice(2, 4);
    const b = h.slice(4, 6);
    const a = h.slice(6, 8);
    // ASS alpha is inverted (00 = opaque, FF = transparent)
    const aInv = (255 - parseInt(a, 16)).toString(16).padStart(2, "0").toUpperCase();
    return `&H${aInv}${b}${g}${r}`;
  }
  return "&H00FFFFFF";
}

const ALIGN_MAP = { bottom: 2, center: 5, top: 8 } as const;

export type AssOverrides = Partial<CaptionStyle>;

export function buildAss(
  words: WordTiming[],
  baseStyle: CaptionStyle,
  videoW: number,
  videoH: number,
  overrides: AssOverrides = {},
): string {
  const s: CaptionStyle = { ...baseStyle, ...overrides };
  const fontSize = Math.round(videoH * s.fontSizeRatio);
  const marginV = Math.round(videoH * s.marginV);
  const align = ALIGN_MAP[s.position];

  // Group words into lines of N words
  const lines: WordTiming[][] = [];
  let cur: WordTiming[] = [];
  for (const w of words) {
    cur.push(w);
    // Break on punctuation OR when full
    const isBreak = /[.!?]$/.test(w.word) || cur.length >= s.maxWordsPerLine;
    if (isBreak) {
      lines.push(cur);
      cur = [];
    }
  }
  if (cur.length) lines.push(cur);

  const events: string[] = [];
  for (const line of lines) {
    if (!line.length) continue;
    const start = line[0].start;
    const end = line[line.length - 1].end;
    const dur = Math.max(0.05, end - start);

    const renderWord = (w: string) => (s.uppercase ? w.toUpperCase() : w);

    if (s.highlightMode === "word") {
      // Karaoke-style: each word swaps to highlight color while spoken
      const parts = line.map((w, i) => {
        const wStart = Math.max(0, w.start - start);
        const wEnd = Math.max(wStart + 0.05, w.end - start);
        const beforeMs = Math.round(wStart * 1000);
        const dur1 = Math.round((wEnd - wStart) * 1000);
        const afterMs = Math.round((dur - wEnd) * 1000);
        const word = renderWord(w.word);
        // Animate color: primary -> highlight -> primary
        const tag =
          `{\\t(${beforeMs},${beforeMs + 1},\\1c${hexToAss(s.highlight)})` +
          `\\t(${beforeMs + dur1},${beforeMs + dur1 + 1},\\1c${hexToAss(s.primary)})}`;
        // Add a small pop scale on the active word
        const pop =
          s.anim === "pop" || s.anim === "bounce"
            ? `{\\t(${beforeMs},${beforeMs + 80},\\fscx115\\fscy115)\\t(${beforeMs + 80},${beforeMs + 200},\\fscx100\\fscy100)}`
            : "";
        return `${tag}${pop}${word}${i < line.length - 1 ? " " : ""}`;
      });
      events.push(
        `Dialogue: 0,${fmtTime(start)},${fmtTime(end)},Caption,,0,0,0,,${parts.join("")}`,
      );
    } else if (s.highlightMode === "line") {
      const text = line.map((w) => renderWord(w.word)).join(" ");
      events.push(
        `Dialogue: 0,${fmtTime(start)},${fmtTime(end)},Caption,,0,0,0,,{\\1c${hexToAss(s.highlight)}}${text}`,
      );
    } else {
      const text = line.map((w) => renderWord(w.word)).join(" ");
      const intro =
        s.anim === "fade"
          ? "{\\fad(150,100)}"
          : s.anim === "slide"
            ? "{\\move(0," + (videoH * 0.05).toFixed(0) + ",0,0)\\fad(150,100)}"
            : s.anim === "pop"
              ? "{\\t(0,150,\\fscx105\\fscy105)\\t(150,250,\\fscx100\\fscy100)\\fad(120,80)}"
              : "";
      events.push(
        `Dialogue: 0,${fmtTime(start)},${fmtTime(end)},Caption,,0,0,0,,${intro}${text}`,
      );
    }
  }

  const styleLine = [
    "Caption",
    s.font,
    fontSize,
    hexToAss(s.primary),
    hexToAss(s.highlight),
    hexToAss(s.outline),
    hexToAss(s.bg ?? "#00000000"),
    s.bold ? -1 : 0,
    s.italic ? -1 : 0,
    0, // Underline
    0, // StrikeOut
    100, // ScaleX
    100, // ScaleY
    s.letterSpacing, // Spacing
    0, // Angle
    s.bg ? 3 : 1, // BorderStyle: 1 = outline, 3 = opaque box
    s.outlineWidth,
    s.shadow,
    align,
    Math.round(videoW * 0.05), // MarginL
    Math.round(videoW * 0.05), // MarginR
    marginV,
    1, // Encoding
  ].join(",");

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${videoW}
PlayResY: ${videoH}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ${styleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}
