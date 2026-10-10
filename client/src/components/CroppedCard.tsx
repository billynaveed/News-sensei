/**
 * Show only the card, not the table it was lying on. The model reports the
 * card's rectangle, so the crop is done with CSS over the original image: no
 * re-encoding, and the full photo is still there for audit and for "Enlarge".
 */
export function CroppedCard({
  src,
  bounds,
  className,
}: {
  src: string;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  className?: string;
}) {
  if (!bounds) {
    return <img src={src} alt="Scanned card" className={`object-cover ${className ?? ""}`} />;
  }
  return (
    <span className={`block overflow-hidden ${className ?? ""}`}>
      <img
        src={src}
        alt="Scanned card"
        className="h-full w-full object-cover"
        style={{
          transform: `scale(${1 / bounds.width}, ${1 / bounds.height}) translate(${-bounds.x * 100}%, ${-bounds.y * 100}%)`,
          transformOrigin: "top left",
        }}
      />
    </span>
  );
}
