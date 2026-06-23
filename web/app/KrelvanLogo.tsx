// Krelvan brand logo — the "Signed K" mark (a K whose lower arm rises into a seal
// stroke) + the wordmark. The mark uses `currentColor` so it themes from the parent's
// CSS color (teal on light, bright-teal on dark) — one source of truth for nav + footer.
import type { CSSProperties } from "react";

/** The mark alone (icon). Inherits color from `currentColor`. */
export function KrelvanMark({ size = 22, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Krelvan"
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      <g fill="none" stroke="currentColor" strokeWidth={6.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 11V53" />
        <path d="M16 32 43 12" />
        <path d="M16 32 27 43 50 16" />
      </g>
    </svg>
  );
}

/**
 * Full lockup: mark + "Krelvan" wordmark. `markColor` themes the mark (defaults to the
 * brand teal token); the wordmark uses the supplied ink color.
 */
export function KrelvanLogo({
  size = 22,
  markColor = "var(--brand)",
  inkColor = "var(--ink)",
  showWordmark = true,
}: {
  size?: number;
  markColor?: string;
  inkColor?: string;
  showWordmark?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, lineHeight: 1 }}>
      <span style={{ color: markColor, display: "inline-flex" }}>
        <KrelvanMark size={size} />
      </span>
      {showWordmark && (
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: size * 0.92,
            letterSpacing: "-0.03em",
            color: inkColor,
          }}
        >
          Krelvan
        </span>
      )}
    </span>
  );
}
