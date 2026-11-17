import type { UserSummaryRow } from '../../../db/selections.js';
import { newAvatarKey } from '../../../shared/media/media-url.js';
import type { ChatMessageRow, ChatRepository, ListChatMessagesParams, NewChatMessage } from '../chat.repository.js';

/** An author as `userSummaryColumns` selects it; `avatar: true` gives a server-shaped key of this very id. */
export function authorRow(
  id: number,
  { avatar = false, ...fields }: Partial<Omit<UserSummaryRow, 'id' | 'avatarKey'>> & { avatar?: boolean } = {},
): UserSummaryRow {
  return {
    id,
    firstName: 'Ada',
    lastName: `Author-${String(id)}`,
    avatarKey: avatar ? newAvatarKey(id) : null,
    ...fields,
  };
}

/** A stored chat message with an explicit id and timestamp (e.g. several rows in one millisecond). */
export function chatRow(id: number, author: UserSummaryRow, createdAt: Date, body = `Message ${String(id)}`) {
  return { id, author, createdAt, body } satisfies ChatMessageRow;
}

/**
 * In-memory `ChatRepository` for the service unit tests (BUILD-ORDER rule 5: feature fakes live in the feature's own
 * `__tests__`). It keeps the repository's contract: newest first by `(createdAt, id)`, keyset `after`, `limit + 1`
 * rows, ids and timestamps assigned on insert (never taken from the caller), and an insert by an unknown author
 * fails like the foreign key would.
 */
export interface FakeChatRepository extends ChatRepository {
  /** Every stored message in insertion order. */
  readonly messages: ChatMessageRow[];
  /** The arguments of every call, for "one round trip" and "the cursor reached the repository" assertions. */
  readonly calls: { listMessages: ListChatMessagesParams[]; insertMessage: NewChatMessage[] };
  /** Registers a user who may author messages (the `users` table of the fake). */
  addAuthor(author: UserSummaryRow): void;
  /** Stores a message as if it already existed (explicit id and timestamp, e.g. several rows in one millisecond). */
  seed(message: ChatMessageRow): void;
  /** Makes the next call of `operation` reject with `error` (a lost connection, a constraint violation). */
  failNext(operation: keyof ChatRepository, error: Error): void;
}

export interface FakeChatRepositoryOptions {
  /** The database clock of `insertMessage`; defaults to `() => new Date()`. */
  now?: () => Date;
}

function compareNewestFirst(a: ChatMessageRow, b: ChatMessageRow): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;
}

/** `(createdAt, id) < (after.createdAt, after.id)`, the row comparison of the real query. */
function isBefore(row: ChatMessageRow, after: NonNullable<ListChatMessagesParams['after']>): boolean {
  const delta = row.createdAt.getTime() - after.createdAt.getTime();
  return delta < 0 || (delta === 0 && row.id < after.id);
}

/** A defensive copy, so a test or the service can never mutate what the fake stores. */
function copyRow(row: ChatMessageRow): ChatMessageRow {
  return { ...row, createdAt: new Date(row.createdAt), author: { ...row.author } };
}

export function createFakeChatRepository({
  now = () => new Date(),
}: FakeChatRepositoryOptions = {}): FakeChatRepository {
  const authors = new Map<number, UserSummaryRow>();
  const messages: ChatMessageRow[] = [];
  const failures = new Map<keyof ChatRepository, Error>();
  const calls: FakeChatRepository['calls'] = { listMessages: [], insertMessage: [] };
  let nextId = 1;

  function takeFailure(operation: keyof ChatRepository): Error | undefined {
    const error = failures.get(operation);
    failures.delete(operation);
    return error;
  }

  return {
    messages,
    calls,
    addAuthor(author) {
      authors.set(author.id, { ...author });
    },
    seed(message) {
      messages.push(copyRow(message));
      nextId = Math.max(nextId, message.id + 1);
    },
    failNext(operation, error) {
      failures.set(operation, error);
    },

    listMessages(params) {
      calls.listMessages.push(params);
      const failure = takeFailure('listMessages');
      if (failure) return Promise.reject(failure);
      const { limit, after } = params;
      const rows = messages
        .filter((row) => (after ? isBefore(row, after) : true))
        .sort(compareNewestFirst)
        .slice(0, limit + 1)
        .map(copyRow);
      return Promise.resolve(rows);
    },

    insertMessage(message) {
      calls.insertMessage.push(message);
      const failure = takeFailure('insertMessage');
      if (failure) return Promise.reject(failure);
      const author = authors.get(message.authorId);
      if (!author) {
        // Shaped like the driver's foreign key violation (23503), which the real insert would raise.
        return Promise.reject(Object.assign(new Error('violates foreign key constraint'), { code: '23503' }));
      }
      const row: ChatMessageRow = { id: nextId++, body: message.body, createdAt: now(), author: { ...author } };
      messages.push(row);
      return Promise.resolve(copyRow(row));
    },
  };
}
