# Part 1: Project Setup

In this section you'll get the starting code into a Codespace and install the dependencies the advanced session needs.

## Step 1: Get the starting code

The starting point is the finished code of the beginner session: [github.com/autodesk-platform-services/au2026-mcp-workshop-beginner](https://github.com/autodesk-platform-services/au2026-mcp-workshop-beginner).

Open it on GitHub and click **Use this template → Create a new repository** (or fork it) so you have a repository of your own to work in. If you already have that code in a repository, create a branch — for example `advanced` — and work there.

> [!CAUTION]
> **TODO**: verify this step ^

## Step 2: Configure secrets

Your server reads its APS credentials from environment variables, and Codespaces injects them for you from account-level secrets.

1. Go to [github.com/settings/codespaces](https://github.com/settings/codespaces).
2. Under **Codespace user secrets**, add two secrets and give your new repository access to both:

   | Name | Value |
   | --- | --- |
   | `APS_CLIENT_ID` | Your APS application client ID |
   | `APS_CLIENT_SECRET` | Your APS application client secret |

Add the secrets *before* creating the Codespace. If you add them afterwards, rebuild the Codespace or stop and restart it so the new values reach the environment.

> **Working locally instead?** Everything in this workshop also runs on a local machine with Node.js 20+. Export the same two variables in your shell before starting the server. Codespaces is the path the instructions assume, and a few later steps call out the local difference.

## Step 3: Open a Codespace

From your repository on GitHub, click **Code → Codespaces → Create codespace on main**. It opens VS Code in the browser with the repository checked out and Node.js already installed.

You can also connect to the same Codespace from the desktop app — press <kbd>F1</kbd> and run **Codespaces: Open in VS Code Desktop**. The terminal, the debugger and the **Ports** panel behave the same either way.

> **Working locally instead?** Skip this step and open the repository folder in VS Code the usual way.

## Step 4: Update package.json

Replace `package.json` with the advanced version:

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

Four dependencies are new, all of them server-side:

| Dependency | Why |
| --- | --- |
| `express` | The web server the MCP endpoint and the OAuth routes are mounted on |
| `@modelcontextprotocol/express` | Express integration for MCP: app setup, bearer-token guard, OAuth metadata routes |
| `@modelcontextprotocol/node` | Adapts the MCP request handler to Node's request/response objects |
| `cors` | Lets browser-based clients call the HTTP endpoint |

Install everything from the VS Code terminal:

```bash
npm install
```

## Checkpoint

You should now have:

- [x] Your own repository with the starting code, open in a Codespace
- [x] `APS_CLIENT_ID` and `APS_CLIENT_SECRET` in the environment
- [x] The advanced `package.json` and a successful `npm install`

```text
.vscode/
  mcp.json
aps.js
mcp.js
index.js
package.json
```

Confirm the credentials arrived:

```bash
echo $APS_CLIENT_ID
```

If that prints nothing, revisit Step 2 — every later part depends on it.

## Additional resources

- [Express documentation](https://expressjs.com/)
- [GitHub Codespaces secrets](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-your-account-specific-secrets-for-github-codespaces)
- [MCP TypeScript SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
