import { createRemoteJWKSet, jwtVerify } from 'jose';

export async function getAuthServerMetadata(issuer) {
    try {
        const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
        if (!response.ok) throw new Error(`responded with HTTP ${response.status}`);
        return await response.json();
    } catch (err) {
        console.error(`Could not reach the authorization server at ${issuer}: ${err.message}`);
        process.exit(1);
    }
}

export function getTokenVerifier(issuer, audience) {
    const authServerJwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    return {
        async verifyAccessToken(token) {
            const { payload } = await jwtVerify(token, authServerJwks, { issuer, audience });
            if (!payload.sub) {
                throw new Error('Access token is missing the "sub" claim.');
            }
            return {
                token,
                clientId: typeof payload.azp === 'string' ? payload.azp : 'unknown',
                scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
                expiresAt: payload.exp,
                extra: { userId: payload.sub },
            };
        }
    };
};
