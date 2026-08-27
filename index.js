import cors from 'cors';
import { createMcpExpressApp, requireBearerAuth, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpServer } from './mcp.js';
import { createOAuthProxy } from './proxy.js';

const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    console.error('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.');
    process.exit(1);
}
const PORT = parseInt(process.env.PORT || '3000');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const CALLBACK_URL = `${PUBLIC_URL}/auth/callback`;

const { router: authProxyRouter, tokenVerifier } = createOAuthProxy({
    issuerUrl: new URL(PUBLIC_URL),
    resourceUrl: new URL(`${PUBLIC_URL}/mcp`),
    apsClientId: APS_CLIENT_ID,
    apsClientSecret: APS_CLIENT_SECRET,
    callbackUrl: CALLBACK_URL,
});
const mcpHandler = createMcpHandler((ctx) => createMcpServer(ctx.authInfo, PUBLIC_URL));

const app = createMcpExpressApp({ host: '0.0.0.0' });
app.use(cors());
app.use(authProxyRouter);

app.use('/mcp', requireBearerAuth({
    verifier: tokenVerifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`${PUBLIC_URL}/mcp`)),
}));

const mcpNodeHandler = toNodeHandler(mcpHandler);
app.all('/mcp', (req, res) => mcpNodeHandler(req, res, req.body));

app.listen(PORT, () => console.log(`MCP server listening on ${PUBLIC_URL}/mcp`));
