/**
 * Lucide file-type icons for the sidebar Explorer / Search trees.
 *
 * Keys match the file-type ids from collectWorkspaceTree
 * (src/features/explorer/tree.mjs): folder, file, code, doc, data, image,
 * script, binary, config.
 */
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';

/** Lucide name per tree type id. */
export const FILE_ICON_NAMES = {
  folder: 'folder',
  file: 'file',
  code: 'file-code',
  doc: 'file-text',
  data: 'file-json',
  image: 'image',
  script: 'terminal',
  binary: 'package',
  config: 'cog',
};

/** Icon tones per file-type id (keys match FileTypeIcon). */
export const FILE_ICON_TONES = {
  folder: 'text-amber-300',
  code: 'text-sky-300',
  doc: 'text-gray-300',
  data: 'text-violet-300',
  image: 'text-emerald-300',
  script: 'text-teal-300',
  binary: 'text-rose-300',
  config: 'text-orange-300',
  file: 'text-gray-400',
};

/**
 * @param {{
 *   type?: string,
 *   open?: boolean,
 *   className?: string,
 * }} props
 */
export function FileTypeIcon({ type = 'file', open = false, className = 'h-3.5 w-3.5' }) {
  let name = FILE_ICON_NAMES[type] || FILE_ICON_NAMES.file;
  if (type === 'folder' && open) name = 'folder-open';
  return <LucideIcon name={name} className={className} />;
}

/** Prebuilt glyphs (closed folder). Prefer FileTypeIcon when open-state matters. */
export const FILE_ICONS = Object.fromEntries(
  Object.keys(FILE_ICON_NAMES).map((type) => [
    type,
    <FileTypeIcon key={type} type={type} />,
  ]),
);
