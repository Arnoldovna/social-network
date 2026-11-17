// The complete v1 schema (DATA-MODEL.md). drizzle.config.ts and db/client.ts both read this file; the single initial
// migration `drizzle/0000_init.sql` is generated from it. Feature phases never change it (ADR-0007, BUILD-ORDER).
export * from './users.js';
export * from './friendships.js';
export * from './wall-posts.js';
export * from './chat-messages.js';
