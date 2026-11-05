/**
 * Vite-friendly Monaco bootstrap — workers before any editor mounts.
 * Monaco 0.57 package exports map `monaco-editor/X` → `esm/vs/X`, so worker
 * imports must use that short form (not `monaco-editor/esm/vs/...`).
 * Without MonacoEnvironment.getWorker, @monaco-editor/react throws on create
 * and React aborts the render that switched the main pane to the editor.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

let ready = false;

export function ensureMonaco() {
  if (ready) return monaco;
  globalThis.MonacoEnvironment = {
    getWorker(_workerId, label) {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };
  loader.config({ monaco });
  ready = true;
  return monaco;
}
