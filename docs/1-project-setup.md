# Part 1: Project Setup

In this section you'll get the starting code onto your machine and install the dependencies the advanced session needs.

## Step 1: Fork the starting code

The starting point is the finished code of the beginner session: [github.com/autodesk-platform-services/au2026-mcp-workshop-beginner](https://github.com/autodesk-platform-services/au2026-mcp-workshop-beginner).

Open it on GitHub and click **Fork → Create fork** so you have a repository of your own to work in. If you already have that code in a repository of your own, create a branch — for example `advanced` — and work there instead.

## Step 2: Clone it locally

Copy the clone URL from your fork's **Code** button, then in a terminal:

```bash
git clone https://github.com/<your-username>/au2026-mcp-workshop-beginner.git aps-mcp-advanced
cd aps-mcp-advanced
```

Then open the folder in VS Code, either with **File → Open Folder** or from the same terminal:

```bash
code .
```

<details>
    <summary>
        Codespaces
    </summary>

Add your credentials as repository secrets **before** you create the Codespace, because secrets are only injected at start-up.

1. In your fork on GitHub, go to **Settings → Secrets and variables → Codespaces**.
2. Click **New repository secret** and add `APS_CLIENT_ID` and `APS_CLIENT_SECRET`, with your APS application's client ID and client secret as the values.
3. Then click **Code → Codespaces → Create codespace on main**. It opens VS Code in the browser with the repository checked out, Node.js installed, and both variables already in the environment.

That covers Step 3 as well — skip it and go straight to Step 4. If you created the Codespace before adding the secrets, stop it and start it again so the new values reach the environment.

</details>

## Step 3: Set your APS credentials

Your server reads its APS credentials from environment variables. Locally you'll keep them in a `.env` file at the project root, and let Node.js and the VS Code debugger load it for you. Create `.env`:

```text
APS_CLIENT_ID=your-client-id
APS_CLIENT_SECRET=your-client-secret
```

No quotes, no `export`, one variable per line. Substitute the **Client ID** and **Client Secret** you copied from your APS application.

Nothing reads this file yet — Step 4 adds the `--env-file-if-exists` flag that loads it on `npm start`, and Part 2 points the debugger at it with `envFile`. The code itself never opens `.env`; it only ever reads `process.env`.

> **`.env` holds a secret. Never commit it.** The repository's `.gitignore` already lists `.env`, so Git ignores it. Confirm with `git status` — if `.env` shows up as untracked, something removed that line and you should put it back before your next commit.

<details>
    <summary>
        Codespaces
    </summary>

Skip this step. Your credentials arrive from the repository secrets you set in Step 2, and there is no `.env` file to create.

</details>

## Step 4: Update package.json

Replace `package.json` with the advanced version:

```json
{
  "name": "au2026-mcp-workshop-advanced",
  "version": "1.0.0",
  "description": "APS MCP Workshop — Advanced Session (AU2026)",
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "start": "node --env-file-if-exists=.env index.js"
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

Two things changed besides the dependencies.

`engines` records the Node.js version this project needs. It is a declaration rather than a hard gate — `npm install` prints an `EBADENGINE` warning on an older runtime and carries on — but it documents the requirement where tooling can read it, and it is the first thing to check when something behaves oddly.

The `start` script gained `--env-file-if-exists=.env`. Node.js reads that file into `process.env` before your code runs, which is what makes the credentials from Step 3 available without exporting anything by hand. The `-if-exists` half matters for the Codespace path: with no `.env` on disk, Node prints a one-line notice and carries on with the variables already in the environment.

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

- [x] Your own fork of the starting code, cloned and open in VS Code
- [x] A `.env` file holding `APS_CLIENT_ID` and `APS_CLIENT_SECRET`
- [x] The advanced `package.json` and a successful `npm install`

```text
.vscode/
  mcp.json
.env
aps.js
mcp.js
index.js
package.json
```

## Try it out

None of the code has changed yet — `index.js`, `mcp.js` and `aps.js` are still the beginner session's STDIO server. Run it now, before Part 2 rewires anything. It proves the credentials, the dependencies and the runtime all work together, so a failure in Part 2 can only have come from Part 2.

### 1. Confirm the credentials load

In the VS Code integrated terminal:

```bash
node --env-file-if-exists=.env -e "console.log(process.env.APS_CLIENT_ID)"
```

It should print your client ID. That's the same flag your `start` script uses, so it proves exactly what the server will see.

If it prints `undefined`, revisit Step 3. Check that `.env` sits at the project root next to `package.json`, that the variable names are spelled exactly as above, and that there are no spaces around the `=`.

<details>
    <summary>
        Codespaces
    </summary>

The same command works — Node skips the missing `.env` and reads the variables the Codespace injected. If it prints `undefined`, the Codespace was created before the secrets were added. Stop it and start it again.

</details>

### 2. Point the MCP config at your .env

`.vscode/mcp.json` came with the beginner repo and registers the server over STDIO:

```json
{
  "servers": {
    "APS MCP Server": {
      "type": "stdio",
      "command": "node",
      "args": ["index.js"]
    }
  }
}
```

VS Code launches `node index.js` as a child process, and nothing in that command reads your `.env`. Add an `envFile` entry so VS Code loads it before starting the process:

```json
{
  "servers": {
    "APS MCP Server": {
      "type": "stdio",
      "command": "node",
      "args": ["index.js"],
      "envFile": "${workspaceFolder}/.env"
    }
  }
}
```

> **Temporary.** Part 2 replaces this whole file with an HTTP entry. An HTTP server is already running under its own environment by the time a client connects, so it needs no `envFile`.

<details>
    <summary>
        Codespaces
    </summary>

Leave the file as it is — the child process inherits the credentials from the environment VS Code is already running in.

</details>

### 3. Start the server

Open `.vscode/mcp.json` and click **Start** on the CodeLens above the `"APS MCP Server"` entry. It should switch to **Running**, with a tool count beside it — this server has two tools.

To see what the process printed, run **MCP: List Servers** from the Command Palette (<kbd>F1</kbd>), pick the server, and choose **Show Output**.

### 4. Ask Copilot

Open Copilot Chat, set the mode dropdown to **Agent**, and ask:

```text
What Forma projects do I have access to?
```

Copilot calls `list-hubs-projects` — approve the call when prompted — and answers from a payload shaped like this:

```json
[
  {
    "id": "b.1234abcd-0000-0000-0000-00000000abcd",
    "name": "My Forma Hub",
    "region": "US",
    "projects": [
      { "id": "b.5678efgh-0000-0000-0000-00000000efgh", "name": "Sample Project" }
    ]
  }
]
```

These are the hubs and projects your APS **application** can reach. Part 3 changes that to the ones *you* can reach.

Click **Stop** on the same CodeLens when you're done.

### Common error states

- **The server fails to start, and the output shows `APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.`** VS Code launched the process without your credentials. Check the `envFile` line for a typo, and that `.env` is where it says it is.
- **`Cannot find package '@modelcontextprotocol/server'`.** `npm install` didn't run, or ran in a different folder. Run it again from the project root.
- **Copilot answers in prose and never calls a tool.** The chat isn't in **Agent** mode. No other mode calls tools.
- **An empty array `[]`.** The server and your credentials are fine, but the APS application isn't provisioned to any Forma hub — revisit **Access to Forma** in the [Prerequisites](0-prerequisites.md). A 2-legged token sees the hubs the *application* was added to, not the hubs *you* belong to.

## Additional resources

- [Express documentation](https://expressjs.com/)
- [Node.js downloads](https://nodejs.org/en/download)
- [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [GitHub Codespaces secrets](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-encrypted-secrets-for-your-repository-and-organization-for-github-codespaces)
- [MCP TypeScript SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
