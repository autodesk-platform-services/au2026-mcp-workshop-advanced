# Extras

## Spec-Driven Development with GitHub Spec-Kit

The advanced server has three moving parts — HTTP transport, per-session OAuth, and the embedded viewer UI — and a change in one layer can quietly break the other two. The beginner workshop walked you through ad-hoc "vibe coding" with Copilot. For features at this scale it pays to slow down: write a specification first, plan the implementation, then let Copilot execute against an explicit checklist.

[GitHub Spec-Kit](https://github.com/github/spec-kit) is a small toolkit that does exactly that. It installs a set of slash commands into Copilot (and other agents) that walk you through a spec-driven workflow.

Some features worth tackling this way:

- **Issues tool.** Add a tool that lists open issues on a project using the [ACC Issues API](https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/issues/). Use the selection event from the viewer to filter issues by element.
- **Multi-model preview.** Extend `preview-design` to accept an array of designs and aggregate them in a single viewer scene with `loadDocumentNode` per model.
- **Persisted sessions.** Replace the in-memory `Map`s in `index.js` with a small store (Redis, SQLite) so a Copilot restart doesn't force the user to log in again.
- **Smarter viewer context.** When the user selects an element, look it up via the Model Derivative properties API and feed a richer description back through `updateModelContext`.
- **Public deployment.** Put the server behind a stable hostname and update the APS app's Callback URL. Containerise it so Vite builds at image-build time and the runtime doesn't need a `dist/` checkout.

### Suggested workflow

1. Install Spec-Kit into your repo. From the project root in your Codespace, run:

   ```bash
   uvx --from git+https://github.com/github/spec-kit.git specify init --here --ai copilot
   ```

   This drops a `.specify/` folder and a set of slash commands into your Copilot configuration. Swap `copilot` for `claude`, `gemini`, etc., if you prefer a different agent.

2. **`/constitution`** — capture the invariants this server already enforces (thin `index.js`, tokens never leave `UserAuthenticationProvider`, `aps.js` doesn't import from `mcp.js`, `PUBLIC_URL` matches the APS Callback URL). Copilot will reference these on every later step.
3. **`/specify`** — describe the feature in plain language. Focus on *what* and *why*, not *how*. Example: "List open issues on a project, filterable by the element currently selected in the viewer."
4. **`/plan`** — let Copilot draft a technical plan: which files change, which APS endpoint it calls, how the result is surfaced through MCP and the viewer UI. Review the plan carefully — HTTP servers and OAuth flows are easier to break than they look.
5. **`/tasks`** — break the plan into discrete, reviewable steps.
6. **`/implement`** — Copilot works through the task list. Test end-to-end via Copilot Chat *and* `npx @modelcontextprotocol/inspector http://localhost:3000/mcp` to isolate transport vs. tool issues.

> **Why spec-first here?** The advanced server crosses three trust boundaries (the MCP client, your Express app, and APS). A short written spec catches scope creep and missing authorisation checks before they land in `index.js` — the file that should stay thin.

## Production checklist

The advanced server is much closer to a real product than the beginner's STDIO build, but it still has rough edges. Address these before shipping:

| Area | Workshop state | Production requirement |
|---|---|---|
| Session store | In-memory `Map` per process | Distributed store with TTL and cleanup |
| Refresh tokens | Held in memory only | Encrypted persistence so users don't re-auth on restart |
| Multi-tenant safety | One process trust boundary | Per-session rate limiting, audit logs, isolation |
| Callback URL | `http://localhost:3000/auth/callback` | HTTPS-only public URL registered in APS |
| Viewer CSP | Permissive `connectDomains` | Tighten to only the endpoints the APS Viewer actually uses |
| Error handling | Errors logged to stderr | Structured logging, alerting, retry/backoff for APS calls |
| Vite bundle | Built on demand | Built at CI time and shipped as part of the artifact |
| MCP client access | Open `/mcp` endpoint | Authenticate the MCP client itself (mTLS, signed tokens, OAuth metadata) |

> **What's next?** With HTTP transport, 3-legged auth, and embedded UI in place, your server can host real product experiments. A natural follow-up is to add write operations (creating folders, uploading versions) — those need careful scoping and user-visible confirmations, but the building blocks are now all here.
