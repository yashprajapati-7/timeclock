// Tiny fetch wrapper for the Time Clock API. No DOM access at import time (tested in Node).
export class ApiError extends Error {
  constructor(status, message, data = {}){
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function call(method, path, body){
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  // Every mutation is JSON (the server answers 415 otherwise), even when there is no body.
  if(method !== 'GET'){ init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body ?? {}); }
  const res = await fetch(path, init);
  if(res.status === 204) return null;
  let data = null;
  try{ data = await res.json(); }catch{ /* empty or non-JSON body */ }
  if(res.status >= 400){
    // A 401 from admin endpoints means the session expired; a wrong login PIN is not that.
    if(res.status === 401 && (path.startsWith('/api/admin') || path === '/api/auth/me')) api.onUnauthorized?.();
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data || {});
  }
  return data;
}

export const api = {
  onUnauthorized: null,
  get: path => call('GET', path),
  post: (path, body) => call('POST', path, body),
  put: (path, body) => call('PUT', path, body),
  del: path => call('DELETE', path),
  // File downloads via fetch, so an expired session or bad week shows a toast instead of a raw JSON page.
  async file(path){
    const res = await fetch(path, { credentials: 'same-origin' });
    if(res.status >= 400){
      let data = {};
      try{ data = await res.json(); }catch{ /* not JSON */ }
      if(res.status === 401) api.onUnauthorized?.();
      throw new ApiError(res.status, data.error || `Download failed (${res.status})`, data);
    }
    const cd = res.headers.get('content-disposition') || '';
    const name = /filename="?([^";]+)"?/.exec(cd)?.[1] || path.split('/').pop().split('?')[0];
    return { blob: await res.blob(), name };
  },
};
