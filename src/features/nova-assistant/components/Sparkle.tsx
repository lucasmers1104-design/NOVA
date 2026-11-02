/** The NOVA sparkle without its tile, drawn in `currentColor` for the assistant's orbs. */
export function Sparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="5 5 22 22" aria-hidden className={className}>
      <path d="M16 5.5 Q17.2 14.8 26.5 16 Q17.2 17.2 16 26.5 Q14.8 17.2 5.5 16 Q14.8 14.8 16 5.5 Z" fill="currentColor" />
      <path d="M23.2 6.6 Q23.5 8.5 25.4 8.8 Q23.5 9.1 23.2 11 Q22.9 9.1 21 8.8 Q22.9 8.5 23.2 6.6 Z" fill="currentColor" opacity="0.7" />
    </svg>
  );
}
