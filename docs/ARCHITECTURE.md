# Kusă architecture — feature-first layout

Kusă is organised **feature-first**: the top-level folders under `src/features/` are the
functional requirements a user can complete, and each one carries its own layers inside it.
Code that more than one feature needs lives once, in `src/shared/`.

This is the opposite of the layer-first layout this repo used to have
(`src/ui/components/`, `src/ui/lib/`, `src/agent/`, `src/mcp/` — every feature's files
scattered across technical layers). See the reasoning below; the pattern is the widely
described "layers inside features" arrangement (as opposed to "features inside layers").

## The rule

1. **A feature is a functional requirement, not a screen.** "See what an agent did" is a
   feature; the Counters panel is one of its layers.
2. **Layers live inside the feature folder**, so everything a feature needs is one hop away:

   | layer dir | holds |
   | --- | --- |
   | `data/` | state, stores, persistence, pure computation |
   | `agent/` | the first-party agent's tools, gates and prompts for that feature |
   | `ui/` | that feature's console panels and view components |
   | `api/` | the feature's public entry point (what `package.json` exports re-export) |

3. **Cross-feature code goes in `src/shared/`**, split by layer (`shared/ui/`, `shared/lib/`).
   If you find yourself importing a sibling feature for a helper, that helper belongs in `shared/`.
4. **The app shell is infrastructure, not a feature.** `src/app/console/` owns the Vite entry,
   the localhost server and the build; it mounts features, it does not render them.

## Layout

```
src/
  app/console/            # infrastructure: serve, hot reload, open-in-editor, build
    serve.mjs  serve-live.mjs  open.mjs  build-css.mjs  vite.config.mjs
    dashboard.{html,js,css}          # committed build output
    ui/                             # the console app shell (Vite entry)
      index.html main.jsx index.css favicon.svg
      features/<feature>/*.jsx      # that feature's panels (mirrors ../../features/<feature>/ui/)
      shared/*.jsx shared/lib/*.js # chrome + primitives used by every feature
  features/
    monitor/              # "see what any agent harness did" (counters, events, lanes)
    chat/                 # "run your own agent in the console" (composer, transcripts, queues, tasks)
    agent/                # "drive work with a first-party harness under real gates"
    skills/               # "keep team standards as canonical skills and publish them"
    mcp/                  # "use Kusă from any MCP client"
    trail/                # "keep and consult team memory (Trail)"
    git/                  # "see the repo state an agent worked against"
    settings/             # "configure the workspace and keep its secrets at rest"
    setup/                # "install Kusă's hooks into a project"
  shared/
    lib/pkg.mjs           # package-root + build-asset resolution (used by every entry point)
    cli/kusa.mjs          # the command surface (dispatches to features)
    templates/            # hook/config templates installed into a project
    data/                 # reference notes
```

## Why the entry points changed shape

Several entry points used to assume "I live in `src/`, so my siblings are the build
output". After the move that assumption is false, so path resolution is centralised in
`src/shared/lib/pkg.mjs`: every consumer of the built `dashboard.*` assets, of
`thresholds.json`, and of `package.json` resolves from there instead of from
`import.meta.url` of a file that happens to sit next to them.

## Import aliases (`package.json` → `imports`)

No import in the tree walks up with `../../`. Anything that leaves its own folder
uses a `#`-prefixed package-import alias, declared once here and resolved natively
by Node (and identically by Vite for the UI build):

| alias | resolves to |
| --- | --- |
| `#features/*` | `src/features/*` |
| `#shared/*` | `src/shared/*` |
| `#app/*` | `src/app/*` |
| `#ui/*` | `src/app/console/ui/*` |
| `#scripts/*` | `scripts/*` |

The rule: **siblings stay relative, anything that leaves its directory is aliased.**
`src/features/skills/store.mjs` imports `./model.mjs` (same folder) and
`#features/monitor/lib.mjs` (another feature); a panel under
`src/app/console/ui/features/chat/` reaches the console chrome as `#ui/shared/…`.
Renaming or moving a folder is then one edit to this map, not a hunt for `../../..`
spread across 53 modules — and a file's import block stops depending on how deep it
happens to sit.

`src/shared/lib/pkg.mjs` exports the same map (`importAliases`,
`resolveImportSpecifier`) so the `--live` server-restart watcher follows the
identical graph Node follows; the two can never disagree about what an edge is.

## Migration map (old → new)

| old | new |
| --- | --- |
| `src/lib.mjs`, `src/hook.mjs`, `src/demo.mjs`, `src/sdk-normalize.mjs`, `src/sdk-listener.mjs`, `src/thresholds.json` | `src/features/monitor/` |
| `src/chat-store.mjs`, `src/chat-turn.mjs`, `src/queue-store.mjs`, `src/task-store.mjs` | `src/features/chat/data/` |
| `src/agent/*` | `src/features/agent/` |
| `src/skills/*` | `src/features/skills/` |
| `src/mcp/*` | `src/features/mcp/` |
| `src/mcp/learnings.mjs` | `src/features/trail/` |
| `src/agent/trail.mjs` | `src/features/trail/agent/` |
| `src/secrets.mjs` | `src/features/settings/` |
| `src/cli/kusa.mjs` | `src/shared/cli/` |
| `src/data/` | `src/shared/data/` |
| `src/serve.mjs`, `src/serve-live.mjs`, `src/open.mjs`, `src/build-css.mjs`, `src/vite.config.mjs` | `src/app/console/` |
| `src/ui/App.jsx` | `src/app/console/ui/App.jsx` (console root component, beside `main.jsx`) |
| `src/ui/**` (everything else) | `src/app/console/ui/**` (panels split per feature, chrome into `ui/shared/`) |
| — new | `src/shared/lib/pkg.mjs` — the one module that knows this package's own paths |
