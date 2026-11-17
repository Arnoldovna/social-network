// The API contract (API.md §1, ADR-0003): Zod schemas, inferred types, limits, policies and socket event maps shared
// by apps/api (validation) and apps/web (forms, typed fetch, sockets). zod is the only dependency; never import apps/*.
export * from './ids.js';
export * from './pagination.js';
export * from './problem.js';
export * from './user.js';
export * from './auth.js';
export * from './profile.js';
export * from './friendships.js';
export * from './wall.js';
export * from './chat.js';
export * from './presence.js';
export * from './uploads.js';
export * from './policy.js';
export * from './realtime.js';
