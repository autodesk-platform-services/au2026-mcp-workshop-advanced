# Prerequisites

Complete these steps **before the workshop**. They take roughly 20 minutes.

## Starting code

This session runs in parallel with the [AU2026 MCP Workshop: Beginner](https://github.com/autodesk-platform-services/au2026-mcp-workshop-beginner), and starts where that one finishes. You don't need to have attended it — the beginner repository is the starting point, and Part 1 shows you how to get it.

What matters is that you're comfortable with the code it produces: a small MCP server (`aps.js`, `mcp.js`, `index.js`) with two read-only tools over a STDIO transport.

## Autodesk Platform Services

If this is the first time you're working with APS, create a new account and a developer hub:

- [Create an account](https://get-started.aps.autodesk.com/#create-an-account)
- [Create a developer hub](https://get-started.aps.autodesk.com/#create-a-developer-hub)

Then, create a new **Traditional Web App** application:

- [Create app credentials](https://get-started.aps.autodesk.com/#create-app-credentials)

Copy the **Client ID** and **Client Secret** — you'll need both. Leave the **Callback URL** for now. It has to match the public URL of your server, which is `http://localhost:3000` when you run the server on your own machine. Part 2 walks you through registering it.

## Access to Forma

An administrator must add your APS application to a Forma hub under **Hub Admin → Custom Integrations**. Because the new MCP server acts on behalf of *a user*, you also need to be **a member of at least one project in that hub** — otherwise the tools return an empty list even though the code works correctly.

## Development environment

You'll run the MCP server on your own machine.

Install all three:

1. The [Visual Studio Code desktop app](https://code.visualstudio.com/).
2. [Node.js 24 or newer](https://nodejs.org/). Check what you have:

   ```bash
   node --version
   ```

   Anything below `v24.0.0` needs upgrading. The code, SDKs, and tools we use in this workshop expect a current runtime.
3. [Git](https://git-scm.com/downloads), to clone the starting code in Part 1.

<details>
    <summary>
        Codespaces
    </summary>

Some corporate laptops may block VS Code, Node.js, or both. You can run the whole workshop in a [GitHub Codespace](https://github.com/codespaces) instead — Part 1 has the steps, and every later part carries a collapsible note wherever the Codespace path differs. Check first that Codespaces is enabled for your account: open [github.com/codespaces](https://github.com/codespaces) and look for a **New codespace** button, then open [github.com/settings/billing](https://github.com/settings/billing) and confirm you have included hours left. The workshop uses about two hours on a 2-core machine. If an organisation policy blocks Codespaces, use a personal GitHub account.

</details>

## GitHub and Copilot

Sign in to [GitHub](https://github.com), then confirm Copilot is actually enabled on your account — available as an individual subscription or through your organisation. A missing entitlement is the one problem you can't fix during the session, so check rather than assume.

### Copilot

1. Open [github.com/settings/copilot](https://github.com/settings/copilot). It should report an active plan; **Copilot Free** is enough.
2. Open [github.com/copilot](https://github.com/copilot) and send any prompt. A reply confirms the plan is live, not just assigned.
3. In VS Code, open Copilot Chat and check that the mode dropdown at the bottom of the chat panel offers **Agent**. The workshop drives your MCP server from agent mode — no other mode calls tools.

## Verify your setup

You're ready when:

- [x] You have an APS **Client ID** and **Client Secret**
- [x] You are a member of at least one project in the Forma hub your APS app is provisioned to
- [x] VS Code desktop is installed
- [x] `node --version` reports `v24.0.0` or newer
- [x] `git --version` reports a version
- [x] Copilot answers a prompt at [github.com/copilot](https://github.com/copilot), and Copilot Chat in VS Code offers **Agent** mode

<details>
    <summary>
        Codespaces
    </summary>

Instead of the VS Code, Node.js and Git rows:

- [x] [github.com/codespaces](https://github.com/codespaces) offers you a **New codespace** button, with included hours remaining

</details>

The workshop instructor will do a quick setup check at the start of the session.
