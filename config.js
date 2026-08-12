const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    console.error('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.');
    process.exit(1);
}
export { APS_CLIENT_ID, APS_CLIENT_SECRET };

export const PORT = parseInt(process.env.PORT || '3000');
export const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
export const MCP_SERVER_URL = new URL(`${PUBLIC_URL}/mcp`);
export const CALLBACK_URL = `${PUBLIC_URL}/auth/callback`;

export const ISSUER_URL = process.env.ISSUER_URL || 'https://dummy-mcp-auth-server.autodesk.io';

export const MCP_SERVER_NAME = 'My APS MCP Server';
export const MCP_SERVER_VERSION = '0.0.1';

export const VIEWER_RESOURCE_URI = 'ui://aps-mcp/viewer.html';
export const VIEWER_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
export const VIEWER_DOMAINS = [
    'https://developer.api.autodesk.com',
    'https://cdn.derivative.autodesk.com',
    'https://fonts.autodesk.com',
];
