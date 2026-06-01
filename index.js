import crypto from 'crypto';
import cors from 'cors';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { UserAuthenticationProvider } from './aps.js';
import { createMcpServer } from './mcp.js';

const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    console.error('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.');
    process.exit(1);
}
const PORT = parseInt(process.env.PORT || '3000');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const authProviders = new Map();
const transports = new Map();

const app = createMcpExpressApp({ host: '0.0.0.0' });
app.use(cors());

app.all('/mcp', async (req, res) => {
    const incomingSessionId = req.headers['mcp-session-id'];
    let transport = incomingSessionId && transports.get(incomingSessionId);

    try {
        if (!transport) {
            const sessionId = crypto.randomUUID();
            const authProvider = new UserAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET, `${PUBLIC_URL}/auth/callback`);
            const server = createMcpServer(authProvider, sessionId, PUBLIC_URL);
            transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
            authProviders.set(sessionId, authProvider);
            transports.set(sessionId, transport);
            await server.connect(transport);
        }
        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        console.error('MCP error:', err);
        throw new McpError(ErrorCode.InternalError, 'Internal server error');
    }
});

app.get('/auth/callback', async (req, res) => {
    const { code, state: sessionId } = req.query;
    if (!code || !sessionId) return res.status(400).send('Missing code or state parameter.');
    const authProvider = authProviders.get(sessionId);
    if (!authProvider) return res.status(400).send('Invalid or expired session.');
    try {
        await authProvider.exchangeAuthCode(code);
        res.send('Login successful! You can close this window and return to your AI assistant.');
    } catch (err) {
        console.error('Auth callback error:', err);
        res.status(500).send('Authentication failed.');
    }
});

app.listen(PORT, () => console.log(`MCP server listening on ${PUBLIC_URL}/mcp`));
