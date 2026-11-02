interface Searchable {
  title: string;
  subtitle?: string;
  group: string;
  keywords?: readonly string[];
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const char of haystack) {
    if (char === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

function scoreTerm(term: string, title: string, extra: string): number {
  if (title === term) return 1000;
  if (title.startsWith(term)) return 800;
  if (title.split(/[\s:]+/).some((word) => word.startsWith(term))) return 600;
  if (title.includes(term)) return 400;
  if (extra.split(/\s+/).some((word) => word.startsWith(term))) return 300;
  if (extra.includes(term)) return 200;
  if (term.length > 1 && isSubsequence(term, title)) return 100;
  return 0;
}

/** Relevance of an item for a query; 0 means no match. Every term must match. */
export function scoreCommand(item: Searchable, query: string): number {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 1;

  const title = item.title.toLowerCase();
  const extra = [item.subtitle, item.group, ...(item.keywords ?? [])].filter(Boolean).join(" ").toLowerCase();
  let total = 0;
  for (const term of terms) {
    const score = scoreTerm(term, title, extra);
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

/** Matching items, best first; ties keep registry order. */
export function filterCommands<T extends Searchable>(items: readonly T[], query: string): T[] {
  return items
    .map((item, index) => ({ item, index, score: scoreCommand(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
