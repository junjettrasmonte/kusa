/** Shared 16×16 stroke icons + icon-only toolbar buttons. */
import { forwardRef } from 'react';

function Svg({ className = 'h-3.5 w-3.5', children }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function PlusIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function RefreshIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3.5H9.5" />
    </Svg>
  );
}

export function ImportIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 2.5v7M5.5 7 8 9.5 10.5 7" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 11.5v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" />
    </Svg>
  );
}

export function ExportIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9.5v-7M5.5 5 8 2.5 10.5 5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 11.5v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" />
    </Svg>
  );
}

export function SaveIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 3.5h7.5L12.5 5.5v7H3.5v-9z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 3.5v3h4v-3M5.5 12.5v-3h5v3" />
    </Svg>
  );
}

export function CopyIcon(props) {
  return (
    <Svg {...props}>
      <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 10.5v-7a1 1 0 0 1 1-1h7" />
    </Svg>
  );
}

export function TrashIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 4.5h9M6 4.5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4.5l.5 8h5l.5-8" />
    </Svg>
  );
}

export function CloseIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function PublishIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 10.5V3.5M5.5 6 8 3.5 10.5 6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />
    </Svg>
  );
}

export function RestoreIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 7.5A4.5 4.5 0 1 0 5 4.5M3.5 3.5v3h3" />
    </Svg>
  );
}

export function EyeIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.75" />
    </Svg>
  );
}

export function EyeOffIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2 2l12 12M6.2 6.3A3.2 3.2 0 0 0 8 11.5c2.8 0 5.2-2.4 6.5-3.5-.5-.6-1.2-1.4-2.1-2.1M4.2 4.4C2.8 5.4 1.5 8 1.5 8s2.5 4.5 6.5 4.5c.7 0 1.3-.1 1.9-.3" />
    </Svg>
  );
}

export function KeyIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="5.5" cy="8" r="2.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 8h5.5l-1.5 1.5M11 8v1.5" />
    </Svg>
  );
}

export function PreviewIcon(props) {
  return (
    <Svg {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 3.5h11v9h-11z" />
      <path strokeLinecap="round" d="M5 6.5h6M5 9h4" />
    </Svg>
  );
}

/**
 * Icon-only button. `label` is required for tooltip + accessibility.
 * variant: default | primary | danger
 */
export const IconButton = forwardRef(function IconButton({
  label,
  icon: Icon,
  variant = 'default',
  className = '',
  type = 'button',
  ...props
}, ref) {
  const variantClass = variant === 'primary'
    ? 'btn-primary'
    : variant === 'danger'
      ? 'btn-danger'
      : 'btn';
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      className={`btn-icon ${variantClass} ${className}`.trim()}
      {...props}
    >
      <Icon />
    </button>
  );
});
