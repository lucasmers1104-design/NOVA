import { gradientCss } from "@/design/backdrop";
import { useWallpaperBackdrop } from "@/design/wallpaper";
import { isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";

/**
 * What the glass refracts: the user's color gradient, their wallpaper (softly
 * blurred and dimmed for legibility), or static ambient light when both are
 * off. Deliberately not animated — a moving backdrop would make every blurred
 * pane re-render each frame.
 */
export function Backdrop() {
  const gradient = useSettings((s) => s.backdropGradient);
  const dim = useSettings((s) => s.backdropDim);
  const enabled = useSettings((s) => s.wallpaperBackdrop && s.transparency);
  const wallpaper = useWallpaperBackdrop(enabled && !gradient && isDesktop());

  if (gradient) {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0" style={{ background: gradientCss(gradient) }} />
        <div className="absolute inset-0" style={{ background: `rgb(9 11 18 / ${dim / 100})` }} />
      </div>
    );
  }

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {wallpaper ? (
        <>
          <img src={wallpaper} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover blur-[36px] saturate-[1.2]" />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgb(9_11_18/0.42)_0%,rgb(9_11_18/0.6)_55%,rgb(9_11_18/0.72)_100%)]" />
        </>
      ) : (
        <>
          <div className="absolute -top-[30%] -left-[10%] h-[85%] w-[65%]" style={{ background: "radial-gradient(closest-side, var(--nova-accent-glow), transparent)" }} />
          <div
            className="absolute top-[25%] -right-[15%] h-[75%] w-[55%]"
            style={{ background: "radial-gradient(closest-side, color-mix(in srgb, var(--nova-accent-secondary) 20%, transparent), transparent)" }}
          />
          <div className="absolute -bottom-[35%] left-[20%] h-[70%] w-[60%]" style={{ background: "radial-gradient(closest-side, rgb(56 189 248 / 0.12), transparent)" }} />
        </>
      )}
      {/* A whisper of the accent ties the backdrop to the theme either way. */}
      <div
        className="absolute -top-[20%] left-[5%] h-[60%] w-[50%] transition-[background] duration-700"
        style={{ background: "radial-gradient(closest-side, color-mix(in srgb, var(--nova-accent) 16%, transparent), transparent)" }}
      />
    </div>
  );
}
