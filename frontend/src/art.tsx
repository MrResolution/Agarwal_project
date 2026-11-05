// Decorative SVG: glowing LED reaction pods on a dark court, used on the hero card and login.
export function PodsArt({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const pods = [
    { x: 210, y: 120, r: 46, lit: true },
    { x: 110, y: 205, r: 30, lit: false },
    { x: 290, y: 230, r: 34, lit: false },
    { x: 170, y: 290, r: 22, lit: false },
  ];
  return (
    <svg viewBox="0 0 360 360" className={className} style={style} aria-hidden>
      <defs>
        <radialGradient id="podGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#e9ff8f" stopOpacity="1" />
          <stop offset=".45" stopColor="#cff25c" stopOpacity=".85" />
          <stop offset="1" stopColor="#cff25c" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="podBody" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#3a4150" />
          <stop offset="1" stopColor="#0f1420" />
        </radialGradient>
      </defs>
      {[60, 110, 160].map((r) => <circle key={r} cx="210" cy="120" r={r} fill="none" stroke="#fff" strokeOpacity=".08" />)}
      {pods.map((p, i) => (
        <g key={i}>
          {p.lit && <circle cx={p.x} cy={p.y} r={p.r * 2.1} fill="url(#podGlow)" />}
          <circle cx={p.x} cy={p.y + p.r * 0.18} r={p.r} fill="#000" opacity=".25" />
          <circle cx={p.x} cy={p.y} r={p.r} fill="url(#podBody)" />
          <circle cx={p.x} cy={p.y} r={p.r * 0.72} fill="none" stroke={p.lit ? "#cff25c" : "#5b6475"} strokeWidth={p.r * 0.16} />
          {Array.from({ length: 12 }).map((_, k) => {
            const a = (k / 12) * Math.PI * 2;
            return <circle key={k} cx={p.x + Math.cos(a) * p.r * 0.72} cy={p.y + Math.sin(a) * p.r * 0.72} r={p.r * 0.05}
              fill={p.lit ? "#fbffe0" : "#7a8395"} />;
          })}
          <circle cx={p.x} cy={p.y} r={p.r * 0.28} fill={p.lit ? "#f5ffd0" : "#2a3140"} />
        </g>
      ))}
    </svg>
  );
}
