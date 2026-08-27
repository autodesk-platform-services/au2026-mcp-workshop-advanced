# Part 1: Project Setup

In this section you'll prepare a fresh project (or branch of the beginner project) with the dependencies the advanced session needs. There are only four additions beyond the beginner set, all of them server-side: `express`, `cors`, and the two MCP adapter packages that put the server on HTTP. The embedded viewer in Part 4 needs no build tooling at all.

## Step 1: Starting point

The advanced session builds directly on the beginner MCP server. You have two ways to get that starting code:

- **Reuse your beginner project**, *as long as you completed every step of the beginner session.* If your beginner repo already has the finished `aps.js`, `mcp.js`, `index.js`, and `.vscode/mcp.json` from the end of Part 3 of the beginner session, branch it (e.g. an `advanced` branch) and evolve it in place.
- **Clone the reference implementation.** If you didn't finish the beginner session — or only got partway through — start from the finished beginner code at [github.com/autodesk-platform-services/au2026-mcp-workshop-beginner](https://github.com/autodesk-platform-services/au2026-mcp-workshop-beginner). Clone it, then continue here.

Either way, add the same two Codespace secrets (or local environment variables) as in the beginner session:

| Name | Value |
| --- | --- |
| `APS_CLIENT_ID` | Your APS application client ID |
| `APS_CLIENT_SECRET` | Your APS application client secret |

## Step 2: Codespace (or local)

Start a Codespace as in the beginner session, or work locally with Node.js 20+ if you prefer. Open the project in VS Code so Copilot can talk to your server later.

> **Port forwarding (read this if you're using a Codespace).** When you start the server in Part 2 it listens on port `3000`, and the OAuth callback in Part 3 needs to be reachable *from your local browser*. Since the browser runs on your laptop and the server runs in the Codespace, `http://localhost:3000/auth/callback` only works if the Codespace forwards port `3000` back to your machine — which it does by default once the server is running. You have two options:
>
> - **Easiest:** keep the default `localhost:3000` callback. In the Codespace **Ports** panel, set port `3000` visibility to **Public** (or **Private** if you'll complete OAuth in the same browser that's signed into the Codespace).
> - **Public hostname:** use the forwarded URL the Codespace assigns (e.g. `https://<codespace>-3000.app.github.dev`). Register `https://<codespace>-3000.app.github.dev/auth/callback` as an additional Callback URL in your APS app, and set `PUBLIC_URL` to `https://<codespace>-3000.app.github.dev` when you start the server in Part 3.

## Step 3: Dependencies

Replace your `package.json` with the advanced version:

```json
{
  "name": "au2026-mcp-workshop-advanced",
  "version": "1.0.0",
  "description": "APS MCP Workshop — Advanced Session (AU2026)",
  "type": "module",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@aps_sdk/authentication": "^1.0.0",
    "@aps_sdk/data-management": "^1.1.0",
    "@modelcontextprotocol/express": "^2.0.0",
    "@modelcontextprotocol/node": "^2.0.0",
    "@modelcontextprotocol/server": "^2.0.0",
    "cors": "^2.8.6",
    "express": "^5.2.1",
    "zod": "^4.4.0"
  }
}
```

What's new compared to the beginner session:

| Dependency | Why |
| --- | --- |
| `@modelcontextprotocol/express` | The `createMcpExpressApp` factory that pre-configures Express for MCP |
| `@modelcontextprotocol/node` | The `toNodeHandler` adapter that bridges the fetch-based MCP handler to Express's `(req, res)` signature |
| `cors` | The HTTP transport needs CORS so the viewer can call APS from the embedded panel |
| `express` | Part 5's `proxy.js` builds its own `express.Router()` for the OAuth endpoints — a direct dependency now, not just a transitive one pulled in by `@modelcontextprotocol/express` |

> **Note:** there are no `devDependencies` and no build step — every dependency listed above is imported by code you actually run. The embedded viewer you build in Part 4 is a single self-contained `viewer.html` that `mcp.js` reads from disk, and the one browser-side library it needs (`@modelcontextprotocol/ext-apps`) is loaded from a CDN by the browser rather than bundled by you. That means `npm install && npm start` is the whole setup: no `npm run build` to forget, and no second copy of the MCP SDK in your tree.

Install everything:

```bash
npm install
```

## Step 4: Folder layout

You'll end up with the following files by the end of the workshop. Everything sits in the project root, so there are no folders to create up front.

```text
.vscode/
  mcp.json               # updated in Part 2
  launch.json            # added in Part 2
viewer.html              # self-contained viewer page, added in Part 4
aps.js                   # from beginner — extended in Parts 3 & 4
mcp.js                   # from beginner — extended in Parts 3, 4 & 5
index.js                 # rewritten in Part 2 — updated in Parts 3, 4 & 5
proxy.js                 # added in Part 5
package.json
```

## Checkpoint

You should now have:

- [x] A repository (new or branched) with `APS_CLIENT_ID` / `APS_CLIENT_SECRET` available
- [x] The advanced `package.json` and a successful `npm install`
- [x] The beginner `aps.js`, `mcp.js`, and `index.js` ready to be edited

### Additional resources

- [Express documentation](https://expressjs.com/)
- [MCP TypeScript SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
- [MCP ext-apps package](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
