import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { callNative, isDesktop } from "@/lib/native";

/**
 * A small, safe Markdown renderer for notes and AI replies. It only ever
 * creates React elements (never HTML strings), so content cannot inject markup.
 * Supported: headings, paragraphs, lists, quotes, rules, fenced code, inline
 * code, bold, italic, strikethrough and http(s) links.
 */

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language: string; code: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "rule" };

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      i++; // closing fence (or end of input while streaming)
      blocks.push({ type: "code", language: fence[1] ?? "", code: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length as 1 | 2 | 3, text: heading[2]!.trim() });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    const listMatch = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m || /\d/.test(m[1]!) !== ordered) break;
        items.push(m[2]!);
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", text: quote.join(" ") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]!)) paragraph.push(lines[i++]!);
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

// Underscores only mark emphasis at word edges, so names like LEGO_Plan_v2.xlsx stay intact.
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|(?<!\w)__[^_]+__(?!\w))|(~~[^~]+~~)|(\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))|(\[[^\]]+\]\([^)\s]+\))/g;

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (match[1]) {
      nodes.push(
        <code key={key} className="rounded-[5px] bg-white/[0.08] px-1.5 py-0.5 font-mono text-[0.88em] text-fg">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      nodes.push(<strong key={key} className="font-semibold text-fg">{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (match[3]) {
      nodes.push(<del key={key}>{renderInline(token.slice(2, -2), key)}</del>);
    } else if (match[4]) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else if (match[5]) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      nodes.push(<SafeLink key={key} href={m[2]!} label={m[1]!} />);
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function SafeLink({ href, label }: { href: string; label: string }) {
  const web = /^https?:\/\//i.test(href);
  if (!web) return <span>{label}</span>;
  return (
    <button
      type="button"
      title={href}
      onClick={() => {
        if (isDesktop()) void callNative("open_url", { url: href });
        else window.open(href, "_blank", "noopener,noreferrer");
      }}
      className="font-medium text-accent-text underline decoration-accent-text/40 underline-offset-2 hover:decoration-accent-text"
    >
      {label}
    </button>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-3 overflow-hidden rounded-[12px] border border-line bg-black/35">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[11px] text-fg-subtle">
        <span className="font-mono">{language || "code"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/[0.08] hover:text-fg"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed">
        <code className="font-mono text-fg select-text">{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className={className}>
      {blocks.map((block, i) => {
        const key = `b-${i}`;
        switch (block.type) {
          case "heading": {
            const sizes = { 1: "text-[19px]", 2: "text-[16px]", 3: "text-[14px]" } as const;
            return (
              <p key={key} role="heading" aria-level={block.level} className={`${sizes[block.level]} mt-4 mb-2 font-semibold text-fg first:mt-0`}>
                {renderInline(block.text, key)}
              </p>
            );
          }
          case "paragraph":
            return (
              <p key={key} className="my-2 leading-relaxed whitespace-pre-wrap first:mt-0 last:mb-0">
                {renderInline(block.text, key)}
              </p>
            );
          case "code":
            return <CodeBlock key={key} code={block.code} language={block.language} />;
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={key} className={`my-2 space-y-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"} marker:text-fg-subtle`}>
                {block.items.map((item, j) => (
                  <li key={j} className="leading-relaxed">
                    {renderInline(item, `${key}-${j}`)}
                  </li>
                ))}
              </List>
            );
          }
          case "quote":
            return (
              <blockquote key={key} className="my-2 border-l-2 border-accent/50 pl-3 text-fg-muted italic">
                {renderInline(block.text, key)}
              </blockquote>
            );
          case "rule":
            return <hr key={key} className="my-4 border-line" />;
        }
      })}
    </div>
  );
}
