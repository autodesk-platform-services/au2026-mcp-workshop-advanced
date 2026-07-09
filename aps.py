import time
from urllib.parse import urlencode

import requests

APS_BASE_URL = 'https://developer.api.autodesk.com'
SCOPES = 'data:read'


class UserAuthenticationProvider:
    def __init__(self, client_id, client_secret, callback_url):
        self.client_id = client_id
        self.client_secret = client_secret
        self.callback_url = callback_url
        self.cache = {'access_token': None, 'refresh_token': None, 'expires_at': 0}

    def is_authenticated(self):
        return bool(self.cache['access_token']) and self.cache['expires_at'] > time.time()

    def get_authorization_url(self, state):
        params = {
            'response_type': 'code',
            'client_id': self.client_id,
            'redirect_uri': self.callback_url,
            'scope': SCOPES,
            'state': state,
        }
        return f'{APS_BASE_URL}/authentication/v2/authorize?{urlencode(params)}'

    def exchange_auth_code(self, code):
        response = requests.post(
            f'{APS_BASE_URL}/authentication/v2/token',
            auth=(self.client_id, self.client_secret),
            data={'grant_type': 'authorization_code', 'code': code, 'redirect_uri': self.callback_url},
        )
        response.raise_for_status()
        self._cache_credentials(response.json())

    def refresh_access_token(self):
        response = requests.post(
            f'{APS_BASE_URL}/authentication/v2/token',
            auth=(self.client_id, self.client_secret),
            data={'grant_type': 'refresh_token', 'refresh_token': self.cache['refresh_token']},
        )
        response.raise_for_status()
        self._cache_credentials(response.json())

    def _cache_credentials(self, credentials):
        self.cache['access_token'] = credentials['access_token']
        self.cache['refresh_token'] = credentials['refresh_token']
        self.cache['expires_at'] = time.time() + credentials['expires_in']

    def get_access_token(self):
        if self.cache['access_token'] and self.cache['expires_at'] > time.time():
            return self.cache['access_token']
        elif self.cache['refresh_token']:
            self.refresh_access_token()
            return self.cache['access_token']
        else:
            raise RuntimeError('Not authenticated')


def get_hubs_projects(authentication_provider):
    headers = {'Authorization': f'Bearer {authentication_provider.get_access_token()}'}
    response = requests.get(f'{APS_BASE_URL}/project/v1/hubs', headers=headers)
    response.raise_for_status()
    hubs = response.json().get('data', [])
    results = []
    for hub in hubs:
        response = requests.get(f'{APS_BASE_URL}/project/v1/hubs/{hub["id"]}/projects', headers=headers)
        response.raise_for_status()
        projects = response.json().get('data', [])
        results.append({
            'id': hub['id'],
            'name': hub['attributes']['name'],
            'region': hub['attributes']['region'],
            'projects': [{'id': p['id'], 'name': p['attributes']['name']} for p in projects],
        })
    return results


def get_folder_contents(hub_id, project_id, folder_id, authentication_provider):
    headers = {'Authorization': f'Bearer {authentication_provider.get_access_token()}'}
    if folder_id:
        url = f'{APS_BASE_URL}/data/v1/projects/{project_id}/folders/{folder_id}/contents'
    else:
        url = f'{APS_BASE_URL}/project/v1/hubs/{hub_id}/projects/{project_id}/topFolders'
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    items = response.json().get('data', [])
    return [
        {
            'type': item['type'],
            'id': item['id'],
            'name': item['attributes']['displayName'],
            'modified_at': item['attributes']['lastModifiedTime'],
            'modified_by': item['attributes']['lastModifiedUserName'],
        }
        for item in items
    ]


def get_item_tip(project_id, item_id, authentication_provider):
    headers = {'Authorization': f'Bearer {authentication_provider.get_access_token()}'}
    response = requests.get(f'{APS_BASE_URL}/data/v1/projects/{project_id}/items/{item_id}/tip', headers=headers)
    response.raise_for_status()
    data = response.json()['data']
    return {
        'name': data['attributes']['displayName'],
        'derivative_urn': data['relationships']['derivatives']['data']['id'],
    }
