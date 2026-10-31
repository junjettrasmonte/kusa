/** Kusă brand mark — rotating tangent circles with a stationary K. */
export function KusaLogo({ className = 'h-7 w-7', title = 'Kusă' }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 320 300"
      role="img"
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="20"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g>
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 160 150"
            to="360 160 150"
            dur="8s"
            repeatCount="indefinite"
          />
          <circle cx="160" cy="150" r="65" />
          <circle cx="160" cy="56" r="29" />
          <circle cx="78.6" cy="197" r="29" />
          <circle cx="241.4" cy="197" r="29" />
        </g>
        <path d="M145 123 V177" />
        <path d="M145 150 L177 123" />
        <path d="M145 150 L177 177" />
      </g>
    </svg>
  );
}
