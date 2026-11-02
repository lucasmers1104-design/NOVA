import { type FormEvent, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { type LayoutTemplate, MAX_LAYOUT_NAME } from "@/features/dashboard/layouts";
import { cn } from "@/lib/cn";

const TEMPLATES: readonly { value: LayoutTemplate; label: string; description: string }[] = [
  { value: "duplicate", label: "Duplicate current", description: "Same widgets and settings" },
  { value: "default", label: "Default", description: "NOVA's starting dashboard" },
  { value: "empty", label: "Empty", description: "Start from scratch" },
];

interface LayoutNameDialogProps {
  open: boolean;
  mode: "create" | "rename";
  initialName: string;
  onClose: () => void;
  onSubmit: (name: string, template: LayoutTemplate) => void;
}

export function LayoutNameDialog({ open, mode, initialName, onClose, onSubmit }: LayoutNameDialogProps) {
  const [name, setName] = useState(initialName);
  const [template, setTemplate] = useState<LayoutTemplate>("duplicate");
  const formId = useId();
  const nameId = useId();

  useEffect(() => {
    if (open) {
      setName(initialName);
      setTemplate("duplicate");
    }
  }, [open, initialName]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    onSubmit(name.trim(), template);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "create" ? "New layout" : "Rename layout"}
      description={mode === "create" ? "Layouts let you switch between dashboards for different moments." : undefined}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" form={formId} disabled={!name.trim()}>
            {mode === "create" ? "Create layout" : "Save"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-5">
        <div>
          <label htmlFor={nameId} className="mb-1.5 block text-[13px] font-medium text-fg">
            Name
          </label>
          <input
            id={nameId}
            data-autofocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_LAYOUT_NAME}
            placeholder="e.g. Focus, Gaming, Evening"
            className="h-10 w-full rounded-control border border-line bg-black/25 px-3 text-[14px] text-fg outline-none select-text placeholder:text-fg-subtle focus:border-line-strong"
          />
        </div>
        {mode === "create" && (
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-fg">Start from</legend>
            <div className="grid grid-cols-3 gap-2">
              {TEMPLATES.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    "flex cursor-default flex-col gap-0.5 rounded-[12px] border px-3 py-2.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent-text",
                    template === option.value ? "accent-soft border-accent/50" : "border-line bg-white/[0.03] hover:border-line-strong",
                  )}
                >
                  <input
                    type="radio"
                    name="template"
                    value={option.value}
                    checked={template === option.value}
                    onChange={() => setTemplate(option.value)}
                    className="sr-only"
                  />
                  <span className="text-[13px] font-medium text-fg">{option.label}</span>
                  <span className="text-[11px] leading-snug text-fg-muted">{option.description}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </form>
    </Dialog>
  );
}
