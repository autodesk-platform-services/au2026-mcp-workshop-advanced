// Demo-only OAuth proxy for this workshop: in-memory, no PKCE or client authentication, and missing most other production checks — replace it with a purpose-built implementation or a third-party identity provider before shipping.

import express from 'express';
import { randomBytes } from 'node:crypto';
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/express';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { UserAuthenticationProvider } from './aps.js';

const TOKEN_TTL_MS = 60 * 60 * 1000;
const generateToken = () => randomBytes(32).toString('base64url');

const cimdCache = new Map();
async function resolveClient(clientId) {
    if (typeof clientId !== 'string' || !clientId.startsWith('https://')) return undefined;
    if (!cimdCache.has(clientId)) {
        cimdCache.set(clientId, await fetch(clientId).then((r) => r.json()));
    }
    return cimdCache.get(clientId);
}

function isRegisteredRedirectUri(requested, client) {
    return typeof requested === 'string' && (client.redirect_uris ?? []).includes(requested);
}

export function createOAuthProxy({ issuerUrl, resourceUrl, apsClientId, apsClientSecret, callbackUrl }) {
    const pendingAuthorizations = new Map();
    const issuedCodes = new Map();
    const sessions = new Map();
    const refreshTokens = new Map();

    function issueTokens(clientId, apsProvider) {
        const accessToken = generateToken();
        const refreshToken = generateToken();
        sessions.set(accessToken, { clientId, apsProvider, expiresAt: Date.now() + TOKEN_TTL_MS });
        refreshTokens.set(refreshToken, { clientId, apsProvider });
        return { access_token: accessToken, token_type: 'bearer', expires_in: TOKEN_TTL_MS / 1000, refresh_token: refreshToken };
    }

    const router = express.Router();
    router.use(express.urlencoded({ extended: false }));

    router.use(mcpAuthMetadataRouter({
        oauthMetadata: {
            issuer: issuerUrl.href,
            authorization_endpoint: new URL('/authorize', issuerUrl).href,
            token_endpoint: new URL('/token', issuerUrl).href,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            client_id_metadata_document_supported: true,
        },
        resourceServerUrl: resourceUrl,
    }));

    router.get('/authorize', async (req, res) => {
        const { client_id: clientId, redirect_uri: redirectUri, state } = req.query;
        const client = await resolveClient(clientId);
        if (!client || !isRegisteredRedirectUri(redirectUri, client)) {
            res.status(400).json({ error: 'invalid_request', error_description: 'Unknown client_id or redirect_uri.' });
            return;
        }
        const correlationId = generateToken();
        const apsProvider = new UserAuthenticationProvider(apsClientId, apsClientSecret, callbackUrl);
        pendingAuthorizations.set(correlationId, { clientId, redirectUri, state, apsProvider });
        res.redirect(`${apsProvider.getAuthorizationUrl()}&state=${correlationId}`);
    });

    router.get('/auth/callback', async (req, res) => {
        const { code, state: correlationId } = req.query;
        try {
            const { clientId, redirectUri, state, apsProvider } = pendingAuthorizations.get(correlationId);
            pendingAuthorizations.delete(correlationId);
            await apsProvider.exchangeAuthCode(code);

            const mcpCode = generateToken();
            issuedCodes.set(mcpCode, { clientId, apsProvider });

            const redirectUrl = new URL(redirectUri);
            redirectUrl.searchParams.set('code', mcpCode);
            if (state) redirectUrl.searchParams.set('state', state);
            res.redirect(redirectUrl.toString());
        } catch (err) {
            console.error('Auth callback error:', err);
            res.status(500).send('Authentication failed.');
        }
    });

    router.post('/token', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const { grant_type: grantType, code, refresh_token: refreshToken } = req.body;
        if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
            res.status(400).json({ error: 'unsupported_grant_type', error_description: `Unsupported grant type: ${grantType}.` });
            return;
        }
        const grant = grantType === 'authorization_code' ? issuedCodes.get(code) : refreshTokens.get(refreshToken);
        if (!grant) {
            res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or expired grant.' });
            return;
        }
        if (grantType === 'authorization_code') issuedCodes.delete(code);
        res.json(issueTokens(grant.clientId, grant.apsProvider));
    });

    return {
        router,
        tokenVerifier: {
            async verifyAccessToken(token) {
                const session = sessions.get(token);
                if (!session) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid token.');
                return {
                    token,
                    clientId: session.clientId,
                    scopes: [],
                    expiresAt: Math.floor(session.expiresAt / 1000),
                    extra: { apsAuthenticationProvider: { getAccessToken: () => session.apsProvider.getAccessToken() } },
                };
            },
        },
    };
}
