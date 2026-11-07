// Stands in for the real Blotato in tests. Calls the real-mode code makes to
// backend.blotato.com are answered here and never reach the internet, so no post can be created.
const realFetch = globalThis.fetch;

const DEFAULT_ACCOUNTS = [
  { id: 'ig-1', platform: 'instagram', fullname: 'Stub IG', username: '@stub_ig' },
  { id: 'ig-2', platform: 'instagram', fullname: 'Stub IG Two', username: '@stub_ig_two' },
  { id: 'tt-1', platform: 'tiktok', fullname: 'Stub TT', username: '@stub_tt' },
  { id: 'li-1', platform: 'linkedin', fullname: 'Stub LI', username: 'stub-li' },
];

function install({ validKey = 'stub-key-not-real=', accounts = DEFAULT_ACCOUNTS } = {}) {
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const statusChecks = new Map();
  const scheduledTimes = new Map(); // postSubmissionId -> scheduledTime, so scheduled posts report "scheduled"

  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (!url.startsWith('https://backend.blotato.com')) {
      if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, options);
      throw new Error(`Test stopped a call leaving this computer: ${url}`);
    }
    const body = options.body ? JSON.parse(options.body) : undefined;
    const pathname = new URL(url).pathname;
    const headers = options.headers || {};
    calls.push({ method: options.method, pathname, body, key: headers['blotato-api-key'] });

    if (headers['blotato-api-key'] !== validKey) return json(401, { message: 'Unauthorized' });
    if (options.method === 'GET' && pathname === '/v2/users/me/accounts') return json(200, { items: accounts });
    if (options.method === 'POST' && pathname === '/v2/media') return json(201, { url: 'https://database.blotato.io/stub/1.jpg', id: 'media_1' });
    if (options.method === 'POST' && pathname === '/v2/posts') {
      const postSubmissionId = `sub-${calls.length}`;
      if (body.scheduledTime) {
        scheduledTimes.set(postSubmissionId, body.scheduledTime);
        return json(201, { postSubmissionId, scheduledTime: body.scheduledTime });
      }
      return json(201, { postSubmissionId });
    }
    if (options.method === 'GET' && pathname.startsWith('/v2/posts/')) {
      const id = pathname.split('/').pop();
      const count = (statusChecks.get(id) || 0) + 1;
      statusChecks.set(id, count);
      if (count < 2) return json(200, { postSubmissionId: id, status: 'in-progress' });
      if (scheduledTimes.has(id)) return json(200, { postSubmissionId: id, status: 'scheduled', scheduledTime: scheduledTimes.get(id) });
      return json(200, { postSubmissionId: id, status: 'published', publicUrl: `https://example.com/stub-post/${id}` });
    }
    return json(404, { message: 'Not found' });
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

module.exports = { install };
