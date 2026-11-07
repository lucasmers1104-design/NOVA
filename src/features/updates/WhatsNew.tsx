import { Sparkles } from "lucide-react";
import { create } from "zustand";
import changelog from "../../../CHANGELOG.md?raw";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Markdown } from "@/components/ui/Markdown";
import { useConsentPrompt } from "@/features/telemetry/api";

export interface ChangelogSection {
  version: string;
  date: string;
  body: string;
}

/** The dialog never gets longer than this, however far behind someone was. */
const MOST_SECTIONS = 5;

/** The released versions in a changelog, newest first as written. */
export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const match = /^(\d+\.\d+\.\d+)(?:\s+—\s+(.+))?\r?\n([\s\S]*)$/.exec(part);
    if (match) sections.push({ version: match[1]!, date: match[2]?.trim() ?? "", body: match[3]!.trim() });
  }
  return sections;
}

/** Negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** What is new in `current` for someone who last ran `lastSeen`. */
export function sectionsSince(text: string, lastSeen: string, current: string): ChangelogSection[] {
  return parseChangelog(text)
    .filter((section) => compareVersions(section.version, lastSeen) > 0 && compareVersions(section.version, current) <= 0)
    .slice(0, MOST_SECTIONS);
}

const useWhatsNew = create<{ sections: ChangelogSection[] }>()(() => ({ sections: [] }));

/** Shows what an update brought; false if the changelog has nothing to say about it. */
export function announceUpdate(lastSeen: string, current: string): boolean {
  const sections = sectionsSince(changelog, lastSeen, current);
  if (sections.length > 0) useWhatsNew.setState({ sections });
  return sections.length > 0;
}

/** Shows the newest changes, whenever someone asks. */
export function showWhatsNew(): void {
  useWhatsNew.setState({ sections: parseChangelog(changelog).slice(0, 3) });
}

/** "What's new": appears by itself once, right after an update. */
export function WhatsNewDialog() {
  const sections = useWhatsNew((s) => s.sections);
  const consentOpen = useConsentPrompt((s) => s.open);
  const close = () => useWhatsNew.setState({ sections: [] });
  return (
    <Dialog
      open={sections.length > 0 && !consentOpen}
      onClose={close}
      size="lg"
      title={sections.length === 1 ? `What's new in NOVA ${sections[0]!.version}` : "What's new in NOVA"}
      footer={
        <Button size="sm" variant="primary" onClick={close} data-autofocus>
          Let's go
        </Button>
      }
    >
      <div className="space-y-5">
        {sections.map((section) => (
          <section key={section.version}>
            {sections.length > 1 && (
              <h3 className="mb-1.5 flex items-center gap-2 text-[13.5px] font-semibold text-fg">
                <Sparkles size={14} className="text-accent-text" aria-hidden />
                NOVA {section.version}
              </h3>
            )}
            <Markdown source={section.body} className="select-text text-[13px] leading-relaxed text-fg-muted" />
          </section>
        ))}
      </div>
    </Dialog>
  );
}
