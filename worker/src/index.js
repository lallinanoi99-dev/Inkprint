// Worker entry. Cloudflare reads every export of this file as a handler, so only the default goes here;
// the routes and helpers live in core.js (which the tests import).
export { default } from './core.js';
