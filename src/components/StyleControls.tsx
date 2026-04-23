import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CaptionStyle } from "@/lib/captionStyles";

type Props = {
  style: CaptionStyle;
  onChange: (s: CaptionStyle) => void;
};

export function StyleControls({ style, onChange }: Props) {
  const upd = <K extends keyof CaptionStyle>(k: K, v: CaptionStyle[K]) =>
    onChange({ ...style, [k]: v });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <ColorField label="Text" value={style.primary} onChange={(v) => upd("primary", v)} />
        <ColorField label="Highlight" value={style.highlight} onChange={(v) => upd("highlight", v)} />
        <ColorField label="Outline" value={style.outline} onChange={(v) => upd("outline", v)} />
        <ColorField
          label="Background"
          value={style.bg ?? "#00000000"}
          onChange={(v) => upd("bg", v === "#00000000" ? null : v)}
          allowAlpha
        />
      </div>

      <SliderRow label="Font Size" value={style.fontSizeRatio * 100} min={2} max={14} step={0.2}
        suffix="%" onChange={(v) => upd("fontSizeRatio", v / 100)} />

      <SliderRow label="Outline Width" value={style.outlineWidth} min={0} max={10} step={1}
        onChange={(v) => upd("outlineWidth", v)} />

      <SliderRow label="Shadow" value={style.shadow} min={0} max={10} step={1}
        onChange={(v) => upd("shadow", v)} />

      <SliderRow label="Letter Spacing" value={style.letterSpacing} min={0} max={10} step={0.5}
        onChange={(v) => upd("letterSpacing", v)} />

      <SliderRow label="Vertical Position" value={style.marginV * 100} min={0} max={50} step={1}
        suffix="%" onChange={(v) => upd("marginV", v / 100)} />

      <SliderRow label="Words Per Line" value={style.maxWordsPerLine} min={1} max={10} step={1}
        onChange={(v) => upd("maxWordsPerLine", v)} />

      <SliderRow label="BG Padding" value={style.bgPadding} min={0} max={40} step={1}
        onChange={(v) => upd("bgPadding", v)} />

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Position</Label>
          <Select value={style.position} onValueChange={(v) => upd("position", v as any)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="top">Top</SelectItem>
              <SelectItem value="center">Center</SelectItem>
              <SelectItem value="bottom">Bottom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Highlight</Label>
          <Select value={style.highlightMode} onValueChange={(v) => upd("highlightMode", v as any)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="word">Per word</SelectItem>
              <SelectItem value="line">Whole line</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Animation</Label>
          <Select value={style.anim} onValueChange={(v) => upd("anim", v as any)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["none", "pop", "fade", "slide", "bounce", "shake", "type"].map((a) => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Font</Label>
          <Select value={style.font} onValueChange={(v) => upd("font", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["Impact", "Arial Black", "Arial", "Helvetica", "Georgia", "Courier New", "Comic Sans MS", "Verdana", "Trebuchet MS"].map((f) => (
                <SelectItem key={f} value={f}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-3">
        <Label className="text-sm">UPPERCASE</Label>
        <Switch checked={style.uppercase} onCheckedChange={(v) => upd("uppercase", v)} />
      </div>
      <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-3">
        <Label className="text-sm">Bold</Label>
        <Switch checked={style.bold} onCheckedChange={(v) => upd("bold", v)} />
      </div>
      <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-3">
        <Label className="text-sm">Italic</Label>
        <Switch checked={style.italic} onCheckedChange={(v) => upd("italic", v)} />
      </div>
    </div>
  );
}

function SliderRow({
  label, value, min, max, step, suffix, onChange,
}: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (v: number) => void; }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
        <span className="font-mono text-xs text-foreground">{value.toFixed(step < 1 ? 1 : 0)}{suffix ?? ""}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} />
    </div>
  );
}

function ColorField({
  label, value, onChange, allowAlpha,
}: { label: string; value: string; onChange: (v: string) => void; allowAlpha?: boolean }) {
  // Color input only handles #RRGGBB, so split alpha
  const base = value.length >= 7 ? value.slice(0, 7) : "#000000";
  const alpha = allowAlpha && value.length === 9 ? value.slice(7, 9) : "FF";
  return (
    <div className="space-y-2">
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={base}
          onChange={(e) => onChange(allowAlpha ? `${e.target.value}${alpha}` : e.target.value)}
          className="h-9 w-10 cursor-pointer rounded border border-border bg-transparent"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 font-mono text-xs"
        />
      </div>
    </div>
  );
}
