import { AuthenticationClient, ResponseType, Scopes } from '@aps_sdk/authentication';
import { DataManagementClient } from '@aps_sdk/data-management';

const SCOPES = [Scopes.DataRead];
const authClient = new AuthenticationClient();

export class UserAuthenticationProvider {
    constructor(clientId, clientSecret) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.accessToken = null;
        this.refreshToken = null;
        this.expiresAt = 0;
    }

    isAuthenticated() {
        return !!this.accessToken;
    }

    setTokens(accessToken, refreshToken, expiresIn) {
        this.accessToken = accessToken;
        this.refreshToken = refreshToken;
        this.expiresAt = Date.now() + expiresIn * 1000;
    }

    async getAccessToken() {
        if (this.accessToken && this.expiresAt > Date.now()) return this.accessToken;
        if (!this.refreshToken) throw new Error('Not authenticated');
        const credentials = await authClient.refreshToken(this.refreshToken, this.clientId, {
            clientSecret: this.clientSecret,
            scopes: SCOPES,
        });
        this.setTokens(credentials.access_token, credentials.refresh_token, credentials.expires_in);
        return this.accessToken;
    }
}

export function getAuthorizationUrl(clientId, callbackUrl, state) {
    return authClient.authorize(clientId, ResponseType.Code, callbackUrl, SCOPES, { state });
}

export function exchangeAuthCode(clientId, clientSecret, code, callbackUrl) {
    return authClient.getThreeLeggedToken(clientId, code, callbackUrl, { clientSecret });
}

export async function getHubsProjects(authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data: hubs = [] } = await client.getHubs();
    return Promise.all(hubs.map(async hub => {
        const { data: projects = [] } = await client.getHubProjects(hub.id);
        return {
            id: hub.id,
            name: hub.attributes.name,
            region: hub.attributes.region,
            projects: projects.map(p => ({ id: p.id, name: p.attributes.name }))
        };
    }));
}

export async function getFolderContents(hubId, projectId, folderId, authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data: items = [] } = folderId
        ? await client.getFolderContents(projectId, folderId)
        : await client.getProjectTopFolders(hubId, projectId);
    return items.map(item => ({
        type: item.type,
        id: item.id,
        name: item.attributes.displayName,
        modifiedAt: item.attributes.lastModifiedTime,
        modifiedBy: item.attributes.lastModifiedUserName
    }));
}

export async function getItemTip(projectId, itemId, authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data } = await client.getItemTip(projectId, itemId);
    return {
        name: data.attributes.displayName,
        derivativeUrn: data.relationships.derivatives.data.id
    };
}
