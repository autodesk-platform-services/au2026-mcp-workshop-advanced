# Extras

## Vibe-Code Additional Features

Now that the server runs over HTTP, authenticates real users, and renders 3D, there are plenty of directions to take it. Some ideas:

- **Issues tool.** Add a tool that lists open issues on a project using the [ACC Issues API](https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/issues/). Use the selection event from the viewer to filter issues by element.
- **Multi-model preview.** Extend `preview-design` to accept an array of designs and aggregate them in a single viewer scene with `loadDocumentNode` per model.
- **Persisted sessions.** Replace the in-memory `Map`s in `index.js` with a small store (Redis, SQLite) so a Copilot restart doesn't force the user to log in again.
- **Smarter viewer context.** When the user selects an element, look it up via the Model Derivative properties API and feed a richer description back through `updateModelContext`.
- **Public deployment.** Put the server behind a stable hostname and update the APS app's Callback URL. Containerise it so Vite builds at image-build time and the runtime doesn't need a `dist/` checkout.

### Suggested approach

1. Describe the feature in plain language to Copilot — your own server is available as a tool, so the model can explore APIs alongside you.
2. Let Copilot draft the change, then review the diff carefully (HTTP servers and OAuth flows are easier to break than they look).
3. Test end-to-end via Copilot Chat *and* `npx @modelcontextprotocol/inspector http://localhost:3000/mcp` to isolate transport vs. tool issues.

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
