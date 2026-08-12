import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { createMcpExpressApp, requireBearerAuth, mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { UserAuthenticationProvider } from './aps.js';
import { createMcpServer } from './mcp.js';
import { getAuthServerMetadata, getTokenVerifier } from './auth.js';
import { APS_CLIENT_ID, APS_CLIENT_SECRET, CALLBACK_URL, MCP_SERVER_URL, MCP_SERVER_NAME, ISSUER_URL, PORT } from './config.js';

const sessions = new Map();

function getSession(userId) {
    if (!sessions.has(userId)) {
        const authProvider = new UserAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET, CALLBACK_URL);
        sessions.set(userId, { authProvider, state: randomUUID() });
    }
    return sessions.get(userId);
}

const app = createMcpExpressApp({ host: '0.0.0.0' });
const mcpAuthMiddleware = requireBearerAuth({
    verifier: getTokenVerifier(ISSUER_URL, MCP_SERVER_URL.href),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_SERVER_URL)
});
const mcpHandler = createMcpHandler((ctx) => {
    const session = getSession(ctx.authInfo.extra.userId);
    return createMcpServer(session.authProvider, session.state);
});
const mcpNodeHandler = toNodeHandler(mcpHandler);

app.use(cors());
app.use(mcpAuthMetadataRouter({
    oauthMetadata: await getAuthServerMetadata(ISSUER_URL),
    resourceServerUrl: MCP_SERVER_URL,
    resourceName: MCP_SERVER_NAME,
}));
app.all('/mcp', mcpAuthMiddleware, (req, res) => mcpNodeHandler(req, res, req.body));
app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state parameter.');
    const session = [...sessions.values()].find(s => s.state === state);
    if (!session) return res.status(400).send('Invalid state parameter.');
    try {
        await session.authProvider.completeLogin(code);
        res.send('Login successful! You can close this window and return to your AI assistant.');
    } catch (err) {
        console.error('Auth callback error:', err);
        res.status(500).send('Authentication failed.');
    }
});

app.listen(PORT, (err) => {
    if (err) {
        console.error('Failed to start server:', err.message);
        process.exit(1);
    }
    console.log(`MCP server running on ${MCP_SERVER_URL}`)
});
