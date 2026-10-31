import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components = {
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-base font-semibold text-gray-100 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-sm font-semibold text-gray-100 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-semibold text-gray-200 first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 text-xs font-semibold uppercase tracking-wide text-gray-300 first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-2 text-sm leading-relaxed text-gray-200 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 text-sm text-gray-200">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 text-sm text-gray-200">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-gray-600 pl-3 text-sm text-gray-400">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline hover:text-sky-200">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-gray-100">{children}</strong>,
  em: ({ children }) => <em className="italic text-gray-200">{children}</em>,
  hr: () => <hr className="my-3 border-gray-800" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs text-gray-200">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-gray-700 text-gray-400">{children}</thead>,
  th: ({ children }) => <th className="px-2 py-1.5 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-t border-gray-800 px-2 py-1.5 align-top">{children}</td>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-gray-950 p-3 font-mono text-xs text-gray-200">{children}</pre>
  ),
  code: ({ className, children }) => {
    const text = String(children).replace(/\n$/, '');
    const fenced = /language-/.test(className || '') || text.includes('\n');
    if (fenced) {
      return <code className="font-mono text-xs text-gray-200">{text}</code>;
    }
    return (
      <code className="rounded bg-gray-950 px-1 py-0.5 font-mono text-[0.85em] text-sky-300">{children}</code>
    );
  },
};

/** Heuristic: treat as markdown when common markup signals are present. */
export function looksLikeMarkdown(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return (
    /(^#{1,6}\s)/m.test(text)
    || /```/.test(text)
    || /\*\*[^*\n]+\*\*/.test(text)
    || /__[^_\n]+__/.test(text)
    || /\[[^\]]+\]\([^)]+\)/.test(text)
    || /(^\s*[-*+]\s+\S)/m.test(text)
    || /(^\s*\d+\.\s+\S)/m.test(text)
    || /\|[^\n]+\|/.test(text)
    || /(^>\s+\S)/m.test(text)
    || /`[^`\n]+`/.test(text)
  );
}

/**
 * @param {object} props
 * @param {string} props.text
 * @param {boolean} [props.truncated]
 * @param {'panel' | 'chat'} [props.variant] panel = bordered scroll box (prompts); chat = inline reply
 * @param {string} [props.className]
 */
export function MarkdownBody({ text, truncated, variant = 'panel', className }) {
  const body = truncated ? `${text}\n\n… truncated` : String(text ?? '');
  const shell = className || (
    variant === 'chat'
      ? 'markdown-body chat-md text-sm text-gray-200'
      : 'markdown-body mt-2 max-h-96 overflow-auto rounded-lg bg-gray-950/80 p-3'
  );
  return (
    <div className={shell}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
