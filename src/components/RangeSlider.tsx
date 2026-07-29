import { RotateCcw } from "lucide-react";

interface RangeSliderProps {
  min: number;
  max: number;
  from: number;
  to: number;
  onChange: (from: number, to: number) => void;
  startLabel: string;
  endLabel: string;
  formatValue?: (value: number) => string;
  resetLabel?: string;
}

/** A small accessible dual-handle range control shared by all dashboard views. */
export function RangeSlider({
  min,
  max,
  from,
  to,
  onChange,
  startLabel,
  endLabel,
  formatValue = String,
  resetLabel = "恢复完整范围",
}: RangeSliderProps) {
  const safeMax = Math.max(min, max);
  const safeFrom = Math.min(Math.max(from, min), safeMax);
  const safeTo = Math.min(Math.max(to, min), safeMax);
  const changed = safeFrom !== min || safeTo !== safeMax;

  return (
    <div className="range-filter" aria-label="时间范围筛选">
      <div className="range-heading">
        <div><span>显示范围</span><strong>{formatValue(safeFrom)} – {formatValue(safeTo)}</strong></div>
        <button
          type="button"
          className="icon-button range-reset"
          onClick={() => onChange(min, safeMax)}
          disabled={!changed}
          aria-label={resetLabel}
          title={resetLabel}
        ><RotateCcw size={14} /></button>
      </div>
      <div className="range-slider">
        <div className="range-rail" />
        <div
          className="range-selection"
          style={{
            left: `${safeMax === min ? 0 : ((safeFrom - min) / (safeMax - min)) * 100}%`,
            right: `${safeMax === min ? 0 : (1 - (safeTo - min) / (safeMax - min)) * 100}%`,
          }}
        />
        <input
          className="range-input range-input-start"
          type="range"
          min={min}
          max={safeMax}
          value={safeFrom}
          aria-label={startLabel}
          aria-valuetext={formatValue(safeFrom)}
          onChange={(event) => onChange(Math.min(Number(event.target.value), safeTo), safeTo)}
          disabled={safeMax === min}
        />
        <input
          className="range-input range-input-end"
          type="range"
          min={min}
          max={safeMax}
          value={safeTo}
          aria-label={endLabel}
          aria-valuetext={formatValue(safeTo)}
          onChange={(event) => onChange(safeFrom, Math.max(Number(event.target.value), safeFrom))}
          disabled={safeMax === min}
        />
      </div>
    </div>
  );
}
