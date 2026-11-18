// The complete v1 schema (DATA-MODEL.md). drizzle.config.ts and db/client.ts both read this file; the migrations in
// `drizzle/` are generated from it (`0000_init`, then `0001_trim_checks_match_js` for B-65). Feature phases never
// change it (ADR-0007, BUILD-ORDER).
export * from './users.js';
export * from './friendships.js';
export * from './wall-posts.js';
export * from './chat-messages.js';
