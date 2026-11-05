import { cn } from "@/lib/cn";
import { type ClockParts, handAngles, type WallClock } from "./time";
import { wordClockLanguage, wordClockText } from "./words";

/** Thin and large, nothing but the time. Sized by the caller through `className`. */
export function MinimalFace({ clock, showSeconds, className }: { clock: ClockParts; showSeconds: boolean; className?: string }) {
  return (
    <p className="flex items-baseline whitespace-nowrap tabular-nums" aria-label={`Current time ${clock.time}`}>
      <span className={cn("leading-none font-extralight tracking-tight text-fg", className)}>{clock.time}</span>
      {showSeconds && <span className="ml-1.5 text-xl font-extralight text-fg-subtle">{clock.seconds}</span>}
      {clock.period && <span className="ml-1.5 text-sm font-light text-fg-subtle">{clock.period}</span>}
    </p>
  );
}

/**
 * Clean analog dial. Hands are placed with SVG attributes and no transition:
 * nothing runs between ticks, and the hands cannot spin backwards at the top of the minute.
 */
export function AnalogFace({ wall, label, showSeconds, showNumbers = false, className }: {
  wall: WallClock;
  label: string;
  showSeconds: boolean;
  showNumbers?: boolean;
  className?: string;
}) {
  const angles = handAngles(wall);
  return (
    <svg viewBox="0 0 100 100" role="img" aria-label={`Current time ${label}`} className={cn("block aspect-square", className)}>
      <circle cx="50" cy="50" r="48.5" strokeWidth="1" className="fill-white/[0.03] stroke-line-strong" />
      {Array.from({ length: 12 }, (_, i) => (
        <line
          key={i}
          x1="50"
          y1="5"
          x2="50"
          y2={i % 3 === 0 ? 10.5 : 8}
          strokeWidth={i % 3 === 0 ? 1.4 : 0.8}
          strokeLinecap="round"
          transform={`rotate(${i * 30} 50 50)`}
          className={i % 3 === 0 ? "stroke-fg-muted" : "stroke-fg-subtle"}
        />
      ))}
      {showNumbers &&
        Array.from({ length: 12 }, (_, i) => {
          const radians = ((i + 1) * Math.PI) / 6;
          return (
            <text
              key={i}
              x={50 + 33.5 * Math.sin(radians)}
              y={50 - 33.5 * Math.cos(radians)}
              fontSize="7.5"
              textAnchor="middle"
              dominantBaseline="central"
              className="fill-fg-muted tabular-nums"
            >
              {i + 1}
            </text>
          );
        })}
      <line data-hand="hour" x1="50" y1="53" x2="50" y2="26" strokeWidth="2.8" strokeLinecap="round" transform={`rotate(${angles.hour} 50 50)`} className="stroke-fg" />
      <line data-hand="minute" x1="50" y1="54" x2="50" y2="14" strokeWidth="1.8" strokeLinecap="round" transform={`rotate(${angles.minute} 50 50)`} className="stroke-fg" />
      {showSeconds && (
        <line data-hand="second" x1="50" y1="56" x2="50" y2="11" strokeWidth="0.8" strokeLinecap="round" transform={`rotate(${angles.second} 50 50)`} className="stroke-accent-text" />
      )}
      <circle cx="50" cy="50" r="2.2" className={showSeconds ? "fill-accent-text" : "fill-fg"} />
    </svg>
  );
}

const FLIP_SIZES = {
  md: { card: "h-[60px] min-w-[54px] px-1.5 text-[36px]", small: "h-[34px] min-w-[32px] px-1 text-[18px]" },
  lg: { card: "h-[84px] min-w-[76px] px-2 text-[54px]", small: "h-[44px] min-w-[42px] px-1 text-[24px]" },
};

function FlipCard({ value, className }: { value: string; className: string }) {
  return (
    <span className={cn("relative inline-flex items-center justify-center rounded-[10px] border border-line bg-black/30 leading-none font-medium text-fg", className)}>
      {value}
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-canvas/70" />
    </span>
  );
}

/** Split-flap look with static cards: the digits simply change, no flip runs. */
export function FlipFace({ clock, showSeconds, size }: { clock: ClockParts; showSeconds: boolean; size: keyof typeof FLIP_SIZES }) {
  const { card, small } = FLIP_SIZES[size];
  return (
    <div role="img" aria-label={`Current time ${clock.time}`} className="flex items-end gap-1.5 tabular-nums">
      <FlipCard value={clock.hour} className={card} />
      <FlipCard value={clock.minute} className={card} />
      {(showSeconds || clock.period) && (
        <div className="flex flex-col items-start gap-1">
          {clock.period && <span className="pl-0.5 text-[11px] font-medium text-fg-muted">{clock.period}</span>}
          {showSeconds && <FlipCard value={clock.seconds} className={small} />}
        </div>
      )}
    </div>
  );
}

/** Word clock in the system's language, German or English. */
export function WordsFace({ wall, className }: { wall: WallClock; className?: string }) {
  return <p className={cn("leading-tight font-light tracking-tight text-fg", className)}>{wordClockText(wall.hours, wall.minutes, wordClockLanguage())}</p>;
}
