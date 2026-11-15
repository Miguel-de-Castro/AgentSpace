// .claude/plans/23-ui-ux-polish.md item 11: `dev:all` starts the API (:4310) and
// the Vite UI (:5173); only the latter is the app. Say so before the logs scroll.
const line = "=".repeat(54);
console.log(`\n${line}\n  AgentSpace UI (use this one):  http://localhost:5173\n  API only:                      http://localhost:4310\n${line}\n`);
