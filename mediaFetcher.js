// mediaFetcher.js
// Opens media links safely. This app downloads whatever link it is given, so without these
// rules a link could make it read private things on your computer or network. That attack
// is called SSRF (server-side request forgery).
//
// Three protections work together:
//   1. The link itself is checked before anything is sent.
//   2. Each redirect is followed by hand and checked like a new link.
//   3. The website's name is turned into an address at the moment of connecting, and the
//      connection is refused if that address is private. A site can't pass the check and
//      then switch to a private address.

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { allowPrivateMedia } = require('./config');

const MAX_REDIRECTS = 5;

// A refusal for safety reasons. Its message is shown to the user.
class BlockedUrlError extends Error {}

const blockedAddresses = new net.BlockList();
[
  ['0.0.0.0', 8], // "This computer"
  ['10.0.0.0', 8], // Private networks
  ['100.64.0.0', 10], // Shared provider networks
  ['127.0.0.0', 8], // This computer (localhost)
  ['169.254.0.0', 16], // Link-local, including cloud metadata services
  ['172.16.0.0', 12], // Private networks
  ['192.0.0.0', 24], // Reserved
  ['192.0.2.0', 24], // Documentation only
  ['192.168.0.0', 16], // Home and office networks
  ['198.18.0.0', 15], // Testing only
  ['198.51.100.0', 24], // Documentation only
  ['203.0.113.0', 24], // Documentation only
  ['224.0.0.0', 4], // Multicast
  ['240.0.0.0', 4], // Reserved, including broadcast
].forEach(([address, prefix]) => blockedAddresses.addSubnet(address, prefix, 'ipv4'));
[
  ['::', 128], // "This computer"
  ['::1', 128], // This computer (localhost)
  // IPv4 written as IPv6 (::ffff:1.2.3.4) is handled in isBlockedAddress. A rule for it here
  // would also match every normal IPv4 address, because BlockList treats them as the same.
  ['64:ff9b::', 96], // IPv4 translation
  ['100::', 64], // Discard only
  ['2001:db8::', 32], // Documentation only
  ['2002::', 16], // IPv4 tunnels
  ['fc00::', 7], // Private networks
  ['fe80::', 10], // Link-local
  ['ff00::', 8], // Multicast
].forEach(([address, prefix]) => blockedAddresses.addSubnet(address, prefix, 'ipv6'));

// Turns ::ffff:127.0.0.1 or ::ffff:7f00:1 back into 127.0.0.1, so the IPv4 rules apply to it.
function unwrapMappedIPv4(address) {
  const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1); // Standard short form, e.g. ::ffff:7f00:1
  const match = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return null;
  const high = parseInt(match[1], 16);
  const low = parseInt(match[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return true; // Not understood, so not trusted.
  if (family === 4) return blockedAddresses.check(address, 'ipv4');
  const mapped = unwrapMappedIPv4(address);
  return mapped ? blockedAddresses.check(mapped, 'ipv4') : blockedAddresses.check(address, 'ipv6');
}

function isBlockedHostname(hostname) {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.intranet') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.home') ||
    !hostname.includes('.') // A bare name like "router" only works on private networks.
  );
}

const PRIVATE_LINK_MESSAGE = 'This link points to a private or internal address, so it was blocked for safety. Blotato could not reach it either. Use a public link.';

// Returns the parsed link, or throws BlockedUrlError saying why it was refused.
function validateMediaUrl(text) {
  let url;
  try {
    url = new URL(String(text).trim());
  } catch {
    throw new BlockedUrlError('That is not a valid web link. It should start with http:// or https://.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError('That is not a valid web link. It should start with http:// or https://.');
  }
  if (url.username || url.password) {
    throw new BlockedUrlError('Links containing a username or password are not allowed. Remove the "name:password@" part and use a public link that needs no login.');
  }
  if (allowPrivateMedia) return url;

  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new BlockedUrlError('Links using an unusual port number (like :8080) are blocked for safety. Use a normal public link without a port number, such as https://example.com/photo.jpg.');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  const isIpAddress = net.isIP(hostname) !== 0;
  if (isIpAddress ? isBlockedAddress(hostname) : isBlockedHostname(hostname)) {
    throw new BlockedUrlError(PRIVATE_LINK_MESSAGE);
  }
  return url;
}

// Runs at the moment of connecting, so the checked address is the one actually used.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!allowPrivateMedia && addresses.some(({ address }) => isBlockedAddress(address))) {
      return callback(new BlockedUrlError(PRIVATE_LINK_MESSAGE));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function requestOnce(url, signal, trusted) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'GET',
        signal,
        lookup: trusted ? dns.lookup : safeLookup,
        agent: false,
        headers: { 'User-Agent': 'BlotatoPreflight/1.0', 'Accept-Encoding': 'identity' },
      },
      resolve
    );
    request.on('error', reject);
    request.end();
  });
}

// Opens a link and follows redirects safely. Returns the final response, whose body has not been read yet.
// "trustedFirstUrl" exists only so the automated tests can start from a test website on this
// computer and prove every redirect is still checked. The app itself never passes it.
async function openMedia(text, signal, { trustedFirstUrl } = {}) {
  const trustFirst = trustedFirstUrl !== undefined && text === trustedFirstUrl;
  let url = trustFirst ? new URL(text) : validateMediaUrl(text);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestOnce(url, signal, trustFirst && hop === 0);
    const isRedirect = [301, 302, 303, 307, 308].includes(response.statusCode);
    if (!isRedirect || !response.headers.location) return response;

    response.resume(); // Throw away the redirect's own body.
    url = validateMediaUrl(new URL(response.headers.location, url).href);
  }
  throw new BlockedUrlError(`The link redirected more than ${MAX_REDIRECTS} times, so it was abandoned. Use the final direct link to the file.`);
}

module.exports = { BlockedUrlError, isBlockedAddress, validateMediaUrl, openMedia };
