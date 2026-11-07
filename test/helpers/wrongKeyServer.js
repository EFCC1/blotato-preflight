// Real mode with a key Blotato's stand-in will reject. Nothing reaches the real Blotato.
process.env.BLOTATO_MOCK = 'false';
process.env.BLOTATO_API_KEY = 'a-wrong-key';
require('./blotatoStub').install({ validKey: 'stub-key-not-real=' });
require('../../server');
