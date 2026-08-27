# Part 1: Project Setup

In this section you'll prepare a fresh project (or branch of the beginner project) with the dependencies the advanced session needs: an HTTP server (Express + CORS), the MCP **ext-apps** package that powers embedded UI resources, and Vite to bundle the viewer HTML into a single file.

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
    "build": "vite build",
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
  },
  "devDependencies": {
    "@modelcontextprotocol/ext-apps": "^1.7.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "vite": "^8.2.2",
    "vite-plugin-singlefile": "^2.3.3"
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
| `vite` + `vite-plugin-singlefile` (dev) | Bundles `ui/viewer.html` (and its imports) into a single inlined HTML string |
| `@modelcontextprotocol/ext-apps` (dev) | The browser-side `App` class the bundled viewer uses to talk back to the MCP client. Only `ui/viewer.js` imports it, and Vite inlines it into `dist/viewer.js` in Part 4 — build time, not run time |
| `@modelcontextprotocol/sdk` (dev) | The **older v1 MCP SDK**, build-time only for the same reason: `ext-apps`'s app bridge imports it, so Vite pulls it into that same bundle. `npm run build` fails without it |

> **Note:** neither MCP package in `devDependencies` is imported by anything you *run*. `index.js`, `mcp.js`, and `proxy.js` import only from `@modelcontextprotocol/server` and its adapters, and `mcp.js` loads the finished `dist/viewer.js`, which already has `ext-apps` and the v1 SDK baked into it as plain JavaScript. They are Vite's dependencies, not the server's. The distinction is worth more than tidiness: two SDK generations sitting side by side in `dependencies` invites the reasonable-but-wrong assumption that the server code imports both.

Install everything:

```bash
npm install
```

## Step 4: Folder layout

You'll end up with the following files by the end of the workshop. Create the `ui/` folder now; you'll fill it in Part 4.

```text
.vscode/
  mcp.json               # updated in Part 2
  launch.json            # added in Part 2
ui/
  viewer.html
  viewer.js
  viewer.css
dist/                    # generated by `npm run build`
  viewer.js              # bundled HTML as an ES module string
aps.js                   # from beginner — extended in Part 2
mcp.js                   # from beginner — extended in Parts 3, 4 & 5
index.js                 # rewritten in Part 3, extended in Part 5
proxy.js                 # added in Part 5
package.json
vite.config.js           # added in Part 4
```

## Checkpoint

You should now have:

- [x] A repository (new or branched) with `APS_CLIENT_ID` / `APS_CLIENT_SECRET` available
- [x] The advanced `package.json` and a successful `npm install`
- [x] The beginner `aps.js`, `mcp.js`, and `index.js` ready to be edited

### Additional resources

- [Express documentation](https://expressjs.com/)
- [Vite documentation](https://vitejs.dev/)
- [MCP TypeScript SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
- [MCP ext-apps package](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
