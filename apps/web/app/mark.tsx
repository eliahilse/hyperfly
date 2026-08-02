export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <g fill="currentColor" transform="skewX(-12)">
        <rect x="3.6" y="4.4" width="18" height="2.7" />
        <rect x="6" y="10.65" width="12.6" height="2.7" />
        <rect x="8.4" y="16.9" width="7.2" height="2.7" />
      </g>
    </svg>
  );
}
