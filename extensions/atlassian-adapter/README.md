# Atlassian Adapter

Built-in Kusă extension that connects [Jira Cloud](https://www.atlassian.com/software/jira) via [`jira.js`](https://github.com/MrRefactoring/jira.js).

Catalog id: `atlassian-adapter` · Folder: `extensions/atlassian-adapter/`

## Dependencies

Declared only in this folder’s `package.json` (`jira.js`, SVAR view packages).
Root `npm install` picks them up via `"workspaces": ["extensions/*"]` — they are
not listed in the root manifest.

## Owns

- Console UI in `ui/` (settings, member discovery, SVAR ticket views)
- Encrypted API token at rest in `.kusa/settings.json` (master key in `~/.config/kusa/`)
- HTTP surface under `/adapters/atlassian/*` (`http.mjs` / `client.mjs` / `settings.mjs`)
- Dev Tools › Atlassian — same panels as Sidebar › Extensions

## Prerequisites

1. An Atlassian Cloud site (`https://your-domain.atlassian.net`)
2. An [API token](https://id.atlassian.com/manage-profile/security/api-tokens) for your Atlassian account email
3. A Jira project key to scope the “assigned to me” list

## Configure

Sidebar › Extensions › **Atlassian Adapter**, or Dev Tools › Atlassian when credentials are missing.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/adapters/atlassian` | Probe credentials + current user |
| GET/PUT | `/adapters/atlassian/settings` | Read/write connection settings |
| GET | `/adapters/atlassian/projects` | Projects visible to the user |
| GET | `/adapters/atlassian/members?project=KEY` | Discover assignable project members |
| GET | `/adapters/atlassian/sprints?project=KEY` | Scrum boards + active/future/closed sprints |
| GET | `/adapters/atlassian/sprints/:id/issues?boardId=` | Issues committed to a sprint |
| GET | `/adapters/atlassian/issues?project=KEY&assignees=me\|all\|id1,id2` | Issues for me / all members / selected account ids |
| GET | `/adapters/atlassian/issues/:key` | Issue detail |
| PUT | `/adapters/atlassian/issues/:key` | Patch summary / description / duedate / assignee / labels |
| GET | `/adapters/atlassian/issues/:key/transitions` | Available status transitions |
| POST | `/adapters/atlassian/issues/:key/transition` | `{ "transitionId": "…" }` |
| GET/POST | `/adapters/atlassian/issues/:key/comments` | List / add comment (`{ "body": "…" }`) |
