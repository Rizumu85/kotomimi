import type { CSSProperties } from 'react';

/** Fork: Kotomimi's own mark (`assets/logo-source.png`, cut to size by `scripts/fork-make-icons.cjs`), for the provider that is this fork's own. */
export function KotomimiIcon({ size = 24, className, style }: { size?: string | number; className?: string; style?: CSSProperties }) {
  return (
    <img
      src={new URL('../../assets/kotomimi.png', import.meta.url).href}
      alt=""
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain', ...style }}
    />
  );
}
