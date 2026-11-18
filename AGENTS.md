# Agent rules

Always follow `rules/errors.md`, `rules/coding-standards.md` and `rules/architecture.md`.

- When writing TypeScript, follow `rules/typescript.md`.
- When a change needs a new or changed type, follow `rules/typespec.md`.
- When changing a table, a migration or a stored record, follow `rules/data-modeling.md`.
- When adding or changing an operation, an MCP tool, a CLI command or the host channel, follow `rules/api.md`.
- When writing or changing a test, follow `rules/tests.md`.
- When committing or opening a pull request, follow `rules/commits-and-prs.md`.
- When writing text a user reads, docs, an issue or a PR body, follow `rules/writing.md`.

## Commands

- `npm install` installs dependencies and enables the pre-commit hook.
- `npm run check` runs every check. `npm run fix` formats.
- `npm test` runs the TypeScript tests.
