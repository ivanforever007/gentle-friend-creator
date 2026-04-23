import { CAPTION_STYLES, type CaptionStyle } from "@/lib/captionStyles";
import { Check } from "lucide-react";

type Props = {
  selectedId: string;
  onSelect: (s: CaptionStyle) => void;
};

export function StylePicker({ selectedId, onSelect }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {CAPTION_STYLES.map((s) => {
        const selected = s.id === selectedId;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s)}
            className={
              "group relative aspect-[9/12] overflow-hidden rounded-xl border text-left transition-all " +
              (selected
                ? "border-primary shadow-glow ring-2 ring-primary/40"
                : "border-border hover:border-primary/60")
            }
            style={{
              background:
                "linear-gradient(135deg, oklch(0.22 0.04 270), oklch(0.16 0.025 270))",
            }}
          >
            <div className="absolute inset-0 flex items-center justify-center px-3 text-center">
              <span
                style={{
                  fontFamily: `${s.font}, system-ui, sans-serif`,
                  fontWeight: s.bold ? 900 : 500,
                  fontStyle: s.italic ? "italic" : "normal",
                  textTransform: s.uppercase ? "uppercase" : "none",
                  letterSpacing: s.letterSpacing,
                  color: s.primary,
                  fontSize: 18,
                  lineHeight: 1.05,
                  padding: s.bg ? "6px 10px" : 0,
                  backgroundColor: s.bg ?? "transparent",
                  borderRadius: s.bg ? 6 : 0,
                  textShadow: s.bg
                    ? "none"
                    : `${s.outlineWidth || 1}px 0 0 ${s.outline}, -${s.outlineWidth || 1}px 0 0 ${s.outline}, 0 ${s.outlineWidth || 1}px 0 ${s.outline}, 0 -${s.outlineWidth || 1}px 0 ${s.outline}`,
                }}
              >
                {s.uppercase ? "BIG TALK" : "Big Talk"}
                <br />
                <span style={{ color: s.highlight }}>
                  {s.uppercase ? "MOMENT" : "moment"}
                </span>
              </span>
            </div>
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2">
              <div className="text-xs font-bold text-white">{s.name}</div>
              <div className="line-clamp-1 text-[10px] text-white/60">{s.tagline}</div>
            </div>
            {selected && (
              <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="h-3.5 w-3.5" strokeWidth={3} />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
