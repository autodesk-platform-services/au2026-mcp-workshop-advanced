import cors from 'cors';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { UserAuthenticationProvider } from './aps.js';
import { createMcpServer } from './mcp.js';

const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    console.error('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.');
    process.exit(1);
}
const PORT = parseInt(process.env.PORT || '3000');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const CALLBACK_URL = `${PUBLIC_URL}/auth/callback`;

const authProvider = new UserAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET, CALLBACK_URL);
const mcpHandler = createMcpHandler(() => createMcpServer(authProvider, PUBLIC_URL));

const app = createMcpExpressApp({ host: '0.0.0.0' });
app.use(cors());

const mcpNodeHandler = toNodeHandler(mcpHandler);
app.all('/mcp', (req, res) => mcpNodeHandler(req, res, req.body));

app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code parameter.');
    try {
        await authProvider.exchangeAuthCode(code);
        res.send('Login successful! You can close this window and return to your AI assistant.');
    } catch (err) {
        console.error('Auth callback error:', err);
        res.status(500).send('Authentication failed.');
    }
});

app.listen(PORT, () => console.log(`MCP server listening on ${PUBLIC_URL}/mcp`));
