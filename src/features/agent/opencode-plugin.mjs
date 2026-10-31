/**
 * OpenCode plugin that replaces built-in file tools with Kusă sandboxed ones.
 * Loaded by the spawned `opencode` process via config.plugin.
 */
import { tool } from '@opencode-ai/plugin';
import { createFileTools } from './files.mjs';

function textResult(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** @type {import('@opencode-ai/plugin').Plugin} */
export const KusaFilesPlugin = async (ctx) => {
  const tools = createFileTools(ctx.directory || ctx.worktree || process.cwd());

  return {
    tool: {
      read: tool({
        description: 'Read a workspace file (Kusă sandboxed).',
        args: {
          path: tool.schema.string().describe('Relative file path'),
          offset: tool.schema.number().optional().describe('1-based start line'),
          limit: tool.schema.number().optional().describe('Max lines'),
        },
        async execute(args) {
          return textResult(await tools.readFile(args));
        },
      }),
      write: tool({
        description: 'Write a workspace file (Kusă sandboxed).',
        args: {
          path: tool.schema.string().describe('Relative file path'),
          contents: tool.schema.string().describe('Full file contents'),
        },
        async execute(args) {
          return textResult(await tools.writeFile(args));
        },
      }),
      edit: tool({
        description: 'Overwrite a workspace file (Kusă sandboxed write).',
        args: {
          path: tool.schema.string().describe('Relative file path'),
          contents: tool.schema.string().describe('Full file contents'),
        },
        async execute(args) {
          return textResult(await tools.writeFile(args));
        },
      }),
      list: tool({
        description: 'List a workspace directory (Kusă sandboxed).',
        args: {
          path: tool.schema.string().optional().describe('Relative directory path'),
          recursive: tool.schema.boolean().optional().describe('Walk nested directories'),
        },
        async execute(args) {
          return textResult(await tools.listDir(args));
        },
      }),
      grep: tool({
        description: 'Search workspace files (Kusă sandboxed).',
        args: {
          pattern: tool.schema.string().describe('Search pattern'),
          path: tool.schema.string().optional().describe('Relative start path'),
          regex: tool.schema.boolean().optional().describe('Treat as regex'),
          caseInsensitive: tool.schema.boolean().optional().describe('Case-insensitive'),
        },
        async execute(args) {
          return textResult(await tools.grep(args));
        },
      }),
      // OpenCode has no built-in delete (models usually reach for bash `rm`, which we deny).
      delete: tool({
        description:
          'Delete a workspace file (Kusă sandboxed). For a directory set recursive=true. Prefer this over bash rm.',
        args: {
          path: tool.schema.string().describe('Relative file or directory path'),
          recursive: tool.schema.boolean().optional().describe('Required to delete a directory'),
        },
        async execute(args) {
          return textResult(await tools.deleteFile(args));
        },
      }),
      kusa_delete_file: tool({
        description:
          'Delete a workspace file (Kusă sandboxed). Alias of delete. For a directory set recursive=true.',
        args: {
          path: tool.schema.string().describe('Relative file or directory path'),
          recursive: tool.schema.boolean().optional().describe('Required to delete a directory'),
        },
        async execute(args) {
          return textResult(await tools.deleteFile(args));
        },
      }),
    },
  };
};

export default KusaFilesPlugin;
