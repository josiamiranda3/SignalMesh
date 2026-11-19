/**
 * Brand mark.
 *
 * The mesh glyph is built from a small deterministic graph: four nodes on a
 * ring plus a centre, joined by hairlines with one signal node highlighted. It
 * reads as "dispersed signals resolved into a structure" and scales cleanly to
 * a favicon because it has no fine detail.
 */
export function Logo({ size = 26, className }: { size?: number; className?: string }) {
  const nodes = [
    { x: 16, y: 5.5 },
    { x: 26.5, y: 12.5 },
    { x: 22.5, y: 24.5 },
    { x: 9.5, y: 24.5 },
    { x: 5.5, y: 12.5 },
  ]
  const center = { x: 16, y: 16 }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id="sm-mark" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7ba4ff" />
          <stop offset="52%" stopColor="#8b7bff" />
          <stop offset="100%" stopColor="#43d9d0" />
        </linearGradient>
      </defs>
      {nodes.map((node, index) => (
        <line
          key={`c-${index}`}
          x1={center.x}
          y1={center.y}
          x2={node.x}
          y2={node.y}
          stroke="url(#sm-mark)"
          strokeWidth="1.15"
          strokeOpacity="0.55"
        />
      ))}
      <line x1={nodes[0]!.x} y1={nodes[0]!.y} x2={nodes[1]!.x} y2={nodes[1]!.y} stroke="url(#sm-mark)" strokeWidth="1.15" strokeOpacity="0.3" />
      <line x1={nodes[2]!.x} y1={nodes[2]!.y} x2={nodes[3]!.x} y2={nodes[3]!.y} stroke="url(#sm-mark)" strokeWidth="1.15" strokeOpacity="0.3" />
      {nodes.map((node, index) => (
        <circle
          key={`n-${index}`}
          cx={node.x}
          cy={node.y}
          r={index === 1 ? 2.1 : 1.6}
          fill={index === 1 ? '#43d9d0' : 'url(#sm-mark)'}
        />
      ))}
      <circle cx={center.x} cy={center.y} r="2.6" fill="#0a0d16" stroke="url(#sm-mark)" strokeWidth="1.4" />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="font-semibold tracking-[-0.02em] text-ink">SIGNAL</span>
      <span className="font-semibold tracking-[-0.02em] text-signal-bright">MESH</span>
    </span>
  )
}
