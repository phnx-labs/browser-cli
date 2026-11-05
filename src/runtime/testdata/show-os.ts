import { showUrl } from '../open-url.js';
console.log(JSON.stringify(await showUrl('https://example.com/', { osBrowser: true })));
