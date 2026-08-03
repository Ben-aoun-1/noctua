interface OwlMarkProps {
  /** Rendered edge length in px; the drawing is a square medallion. */
  size?: number
  className?: string
}

/**
 * Noctua's mark: a line-art owl inside a thin medallion, drawn the way Minerva's engraved head is —
 * one weight of line, no fills, no shadow.
 *
 * The silhouette is a single closed figure: the two brow arcs *are* the top of the head, and the
 * body picks up exactly where they end, so the owl reads at 20px as well as at 120px. Everything is
 * `currentColor`, which lets the same component sit in ink on ivory here and in cream on ink later
 * without a second copy.
 */
export default function OwlMark({ size = 44, className }: OwlMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="Noctua"
    >
      {/* The medallion. */}
      <circle cx="24" cy="24" r="21.25" />
      {/* The bird: one unbroken silhouette, head and body together. */}
      <path d="M24 11.6C16.8 11.6 13 17.4 13 24.2C13 32.4 17.8 38.8 24 40C30.2 38.8 35 32.4 35 24.2C35 17.4 31.2 11.6 24 11.6Z" />
      {/* Two brow arcs meeting over the beak — the owl's whole expression lives here. */}
      <path d="M15.8 21.2C18.6 18.8 21.6 19.2 24 22C26.4 19.2 29.4 18.8 32.2 21.2" />
      {/* Eyes, large on purpose: it is what still reads as an owl at 20px. */}
      <circle cx="19.5" cy="25.4" r="3" />
      <circle cx="28.5" cy="25.4" r="3" />
      <circle cx="19.5" cy="25.4" r="0.9" />
      <circle cx="28.5" cy="25.4" r="0.9" />
      {/* Beak. */}
      <path d="M22.4 28.6L24 31.6L25.6 28.6" />
      {/* Folded wings: they leave the silhouette at the shoulder and run just inside it. */}
      <path d="M13.6 26.2C14 31 16.2 35.2 19.6 37.6" />
      <path d="M34.4 26.2C34 31 31.8 35.2 28.4 37.6" />
    </svg>
  )
}
