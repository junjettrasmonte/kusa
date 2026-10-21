import { KusaLogo } from './KusaLogo.jsx';

const LOGO = {
  cursor: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M12 2 21 7v10l-9 5-9-5V7z" />
      <path d="M12 12 3 7M12 12l9-5M12 12v10" />
    </svg>
  ),
  'github-copilot': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M4 9.5C4 6 7.5 4 12 4s8 2 8 5.5V15c0 2.5-3.5 5-8 5s-8-2.5-8-5z" />
      <rect x="6.75" y="10" width="4" height="4.5" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.25" y="10" width="4" height="4.5" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  'vscode-local': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />
    </svg>
  ),
};

export function HarnessLogo({ harness, size = 'h-4 w-4' }) {
  if (harness === 'kusa') {
    return <KusaLogo className={`${size} shrink-0`} title="" />;
  }
  return (
    <span className={`inline-flex shrink-0 ${size} [&>svg]:h-full [&>svg]:w-full`}>
      {LOGO[harness] || LOGO['vscode-local']}
    </span>
  );
}
