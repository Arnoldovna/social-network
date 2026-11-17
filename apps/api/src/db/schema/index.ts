// Tables arrive in phase 1b (users, friendships, wall_posts, chat_messages; DATA-MODEL.md). Until then the schema is
// empty, so `drizzle-kit generate` reports no changes and the CI schema drift check has nothing to diff.
export {};
