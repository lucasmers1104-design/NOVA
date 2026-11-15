import { Hash } from "lucide-react";
import { Avatar } from "./ProfileLink";

/** How a message from NOVA looks in Discord: dark chat, round avatar, name, APP tag, time. */
export function DiscordPreview({ author, text, channel, avatar = null }: { author: string; text: string; channel?: string; avatar?: string | null }) {
  const time = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return (
    <figure aria-label="Vorschau in Discord" className="overflow-hidden rounded-2xl border border-black/40 bg-[#313338] text-left shadow-[0_18px_40px_-24px_rgb(0_0_0/0.8)]">
      {channel && (
        <figcaption className="flex items-center gap-1.5 border-b border-black/30 px-4 py-2.5 text-[13px] font-semibold text-[#f2f3f5]">
          <Hash size={16} className="text-[#80848e]" aria-hidden />
          {channel}
        </figcaption>
      )}
      <div className="flex gap-3.5 px-4 py-3.5">
        <Avatar me={{ name: author, shownAs: author, avatar }} className="size-10 text-[15px]" />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-[14px] leading-tight">
            <span className="font-medium text-[#f2f3f5]">{author}</span>
            <span className="rounded-[3px] bg-[#5865F2] px-1 py-px text-[10px] font-semibold text-white">APP</span>
            <span className="text-[11.5px] text-[#949ba4]">Heute um {time}</span>
          </p>
          <p className="mt-1 text-[14px] leading-snug break-words whitespace-pre-wrap text-[#dbdee1]">{text}</p>
        </div>
      </div>
    </figure>
  );
}
