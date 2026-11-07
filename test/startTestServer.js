// Starts the app in mock mode for browser testing, allowing the test media website on this computer.
process.env.BLOTATO_MOCK = 'true';
process.env.PREFLIGHT_ALLOW_PRIVATE_MEDIA = 'true';
require('../server');
