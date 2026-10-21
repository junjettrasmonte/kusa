/**
 * Static catalog of Kusă MCP tools (names + schemas). Runtime handlers live
 * in tools.mjs; enable flags live in config.mjs.
 */
export const TOOL_CATALOG = [
  {
    name: 'kusa_list_skills',
    description:
      'List Kusă agent skills from the canonical store (.kusa/skills). Returns id, name, description, category, and publication status.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_get_skill',
    description:
      'Read one Kusă skill by id (directory name). Returns SKILL.md body and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Skill id / directory name (kebab-case)' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_list_learnings',
    description:
      'List Trail learnings (team memory) from .trail/learnings/. Newest first. Use before repeating solved decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        personal: {
          type: 'boolean',
          description: 'Also include personal notes from ~/.trail/notes',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_add_learning',
    description:
      'Save a Trail learning (team memory) for this repo via trail note when available. Title + body required.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the learning' },
        body: { type: 'string', description: 'What was decided, tried, or ruled out' },
        personal: {
          type: 'boolean',
          description: 'Store as a personal note (~/.trail) instead of the repo',
        },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_get_session',
    description:
      'Summarize the latest Kusă monitor focus session (status, tool counts, current intent) from .kusa/.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_read_file',
    description:
      'Read a UTF-8 text file from the workspace (sandboxed under the project root).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' },
        offset: { type: 'integer', description: '1-based start line' },
        limit: { type: 'integer', description: 'Max lines' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_write_file',
    description:
      'Create or overwrite a UTF-8 text file under the workspace (sandboxed).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' },
        contents: { type: 'string', description: 'Full file contents' },
      },
      required: ['path', 'contents'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_patch_file',
    description:
      'Apply targeted search/replace edits to a workspace file without rewriting it (sandboxed). Each oldText must match exactly once unless replaceAll=true; edits apply in order and the write is atomic — if an edit fails, nothing is written and the error names the failing edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path (must exist)' },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          description: 'Ordered search/replace edits',
          items: {
            type: 'object',
            properties: {
              oldText: {
                type: 'string',
                description: 'Exact text to find (verbatim, unique unless replaceAll)',
              },
              newText: { type: 'string', description: 'Replacement text' },
              replaceAll: {
                type: 'boolean',
                description: 'Replace every occurrence instead of requiring a unique match',
              },
            },
            required: ['oldText', 'newText'],
            additionalProperties: false,
          },
        },
        dryRun: {
          type: 'boolean',
          description: 'Validate and preview the patch without writing the file',
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_list_dir',
    description: 'List files and directories under a workspace path (sandboxed).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path (default ".")' },
        recursive: { type: 'boolean', description: 'Walk nested directories (capped)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_grep',
    description: 'Search file contents under the workspace for a literal or regex pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern' },
        path: { type: 'string', description: 'Relative start path (default ".")' },
        regex: { type: 'boolean', description: 'Treat pattern as JavaScript regex' },
        caseInsensitive: { type: 'boolean', description: 'Case-insensitive match' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_delete_file',
    description:
      'Delete a file under the workspace (sandboxed). For directories, set recursive=true. Cannot delete the workspace root, .git, or .kusa.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file or directory path' },
        recursive: {
          type: 'boolean',
          description: 'Required to delete a directory',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

export function defaultToolFlags() {
  const tools = {};
  for (const t of TOOL_CATALOG) tools[t.name] = true;
  return tools;
}
