// Runs the app's REAL-mode code for browser testing, with Blotato replaced by a local stand-in.
// Nothing reaches Blotato and no post can be created. The key below is a placeholder, not a real one.
process.env.BLOTATO_MOCK = 'false';
process.env.BLOTATO_API_KEY = 'stub-key-not-real=';
require('./helpers/blotatoStub').install();
require('../server');
