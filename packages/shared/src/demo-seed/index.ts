// The demo data (DATA-MODEL.md "Seed plan", ADR-0020): the people, the friendship graph, the walls, the chat, the
// timeline and the avatar designs. Pure data and functions, no dependencies. Shared by the API seed
// (apps/api/src/db/seed) and the GitHub Pages demo (apps/web/src/demo), so both show the same data. A subpath of its own
// (`@app/shared/demo-seed`), not part of the contract entry point, so nothing else bundles it.
export * from './people.js';
export * from './content.js';
export * from './avatar-design.js';
export * from './plan.js';
