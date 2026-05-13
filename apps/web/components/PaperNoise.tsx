export function PaperNoise() {
  // Light mode: multiply a warm brown noise onto cream paper for that
  // letterpress feel. Dark mode: switch to soft-light + lower opacity so
  // the same texture reads as faint grain instead of fully blacking out.
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[1] opacity-[0.42] mix-blend-multiply dark:opacity-[0.22] dark:mix-blend-soft-light"
      style={{
        backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.92' numOctaves='2' seed='4'/><feColorMatrix values='0 0 0 0 0.55 0 0 0 0 0.46 0 0 0 0 0.36 0 0 0 0.06 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")`,
      }}
    />
  )
}
