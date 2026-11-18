import {
  AVATAR_FIELD,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_PIXELS,
  AVATAR_MAX_SIDE_PX,
  AuthResponse,
  canDeleteWallPost,
  ChatMessage,
  ChatPage,
  CreatePostBody,
  CreatePostResponse,
  CsrfTokenResponse,
  FriendshipChange,
  FriendshipsResponse,
  IdParam,
  LoginBody,
  MeResponse,
  PageQuery,
  PresenceResponse,
  RegisterBody,
  SearchQuery,
  SearchResponse,
  SendChatMessage,
  SendFriendRequestBody,
  UpdateMeBody,
  UserProfileResponse,
  WallPage,
} from '@app/shared';
import type {
  WallPost,
  FriendshipState,
  PublicUser,
  RelationshipState,
  ServerToClientEvents,
  UserSummary,
} from '@app/shared';
import { renderAvatarSvg } from '@app/shared/demo-seed';

import { compareByName } from '../shared/lib/names';
import { formatCount } from '../shared/lib/format-count';
import { hashPassword, newSalt, verifyPassword } from './password';
import type { DemoPersistence } from './persistence';
import { DemoProblem, parseOrThrow } from './problem';
import type { DemoFriendship, DemoMessage, DemoPost, DemoState, DemoUser } from './state';

/** Who receives a server -> client event (API.md §3): one user's sockets, a wall room, or every socket. */
export type RealtimeTarget = { kind: 'user'; userId: number } | { kind: 'wall'; ownerId: number } | { kind: 'all' };

/** The demo's socket server as the backend sees it (implemented by `realtime.ts`, faked in tests). */
export interface RealtimeEmitter {
  emit<Event extends keyof ServerToClientEvents>(
    target: RealtimeTarget,
    event: Event,
    ...args: Parameters<ServerToClientEvents[Event]>
  ): void;
  /** `userId`'s sockets leave the room of `ownerId`'s wall (after an unfriend, like the API's `leaveRoom`, B-39). */
  leaveWall(userId: number, ownerId: number): void;
  /** The server closes every socket of `userId` (after a logout, like the API's `disconnectSession`, F-20). */
  endSession(userId: number): void;
}

/** Width and height of an image, or `null` when it cannot be decoded (the API's sharp `metadata()` step). */
export type MeasureImage = (image: Blob) => Promise<{ width: number; height: number } | null>;

export interface DemoBackendDeps {
  state: DemoState;
  persistence: DemoPersistence;
  realtime: RealtimeEmitter;
  measureImage: MeasureImage;
  now?: () => Date;
  randomUUID?: () => string;
}

/** An image the avatar route answers with: an upload from IndexedDB or a seeded design as SVG. */
export interface AvatarImage {
  body: Blob | string;
  contentType: string;
}

const CURSOR = /^id:([1-9]\d{0,9})$/;

function cursorOf(id: number): string {
  return `id:${String(id)}`;
}

/** The id below which the next page starts, or `undefined` for the first page (400 `invalid-cursor` otherwise). */
function cursorId(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const match = CURSOR.exec(cursor);
  if (match?.[1] === undefined) throw new DemoProblem(400, 'invalid-cursor', 'The cursor is not valid.');
  return Number(match[1]);
}

/** Newest first by id (ids grow with `createdAt`, as in the seeded database), `limit` per page. */
function pageNewestFirst<Row extends { id: number }>(
  rows: readonly Row[],
  { limit, cursor }: { limit: number; cursor?: string | undefined },
): { items: Row[]; nextCursor: string | null } {
  const before = cursorId(cursor);
  const newestFirst = rows.filter((row) => before === undefined || row.id < before).sort((a, b) => b.id - a.id);
  const items = newestFirst.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: newestFirst.length > limit && last !== undefined ? cursorOf(last.id) : null };
}

/** Magic bytes of the accepted avatar types (the API sniffs the same way, ADR-0010). */
function sniffImageType(bytes: Uint8Array): string | null {
  const startsWith = (signature: readonly number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/**
 * The real API's behaviour for the demo, in the browser (ADR-0020): sessions, CSRF, auth, profiles, search, avatar
 * upload, friendships, walls, chat and presence over one in-memory `DemoState`, written to `persistence` after every
 * change. Every input is parsed with the shared Zod contract and every answer is parsed with the response schema
 * before it leaves, so the demo can never drift from the contract the app is built against. Failures are
 * `DemoProblem`s with the API's status codes and problem codes.
 */
export class DemoBackend {
  readonly #state: DemoState;
  readonly #persistence: DemoPersistence;
  readonly #realtime: RealtimeEmitter;
  readonly #measureImage: MeasureImage;
  readonly #now: () => Date;
  readonly #randomUUID: () => string;
  /** The CSRF token of the current session; in memory only, like the session-bound token of csrf-csrf. */
  #csrfToken: string | null = null;
  /** Simulated people who are online right now (presence is never persisted, as in Redis with a TTL). */
  readonly #online = new Set<number>();

  constructor({ state, persistence, realtime, measureImage, now, randomUUID }: DemoBackendDeps) {
    this.#state = state;
    this.#persistence = persistence;
    this.#realtime = realtime;
    this.#measureImage = measureImage;
    this.#now = now ?? (() => new Date());
    this.#randomUUID = randomUUID ?? (() => crypto.randomUUID());
  }

  // --- session and CSRF -------------------------------------------------------------------------------------------

  /** `GET /api/csrf-token`: the session's token, created on first use. */
  csrfToken(): CsrfTokenResponse {
    this.#csrfToken ??= this.#randomUUID();
    return CsrfTokenResponse.parse({ token: this.#csrfToken });
  }

  /** Every unsafe method needs the session's token in `x-csrf-token` (403 `csrf-invalid` otherwise, F-23). */
  assertCsrf(header: string | null): void {
    if (this.#csrfToken === null || header !== this.#csrfToken) {
      throw new DemoProblem(403, 'csrf-invalid', 'The CSRF token is missing or invalid.');
    }
  }

  /** The signed-in user's id, or `null` for a visitor (the socket handshake uses it too). */
  sessionUserId(): number | null {
    const id = this.#state.sessionUserId;
    return id !== null && this.#findUser(id) !== undefined ? id : null;
  }

  #requireUser(): DemoUser {
    const id = this.#state.sessionUserId;
    const user = id === null ? undefined : this.#findUser(id);
    if (user === undefined) throw new DemoProblem(401, 'unauthorized', 'Please log in.');
    return user;
  }

  /** A new session: like `req.session.regenerate`, it gets a new CSRF token, returned in the auth response. */
  async #startSession(user: DemoUser): Promise<AuthResponse> {
    this.#state.sessionUserId = user.id;
    this.#csrfToken = this.#randomUUID();
    await this.#save();
    return AuthResponse.parse({ user: this.#publicUser(user), csrfToken: this.#csrfToken });
  }

  // --- auth -------------------------------------------------------------------------------------------------------

  async register(input: unknown): Promise<AuthResponse> {
    const body = parseOrThrow(RegisterBody, input, 'body');
    if (this.#state.users.some((user) => user.email === body.email)) {
      throw new DemoProblem(409, 'email-taken', 'This email address is already registered.', [
        { location: 'body', path: 'email', message: 'This email address is already registered.' },
      ]);
    }
    const salt = newSalt();
    const user: DemoUser = {
      id: this.#nextId('users'),
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      bio: null,
      salt,
      passwordHash: await hashPassword(body.password, salt),
      avatar: null,
      createdAt: this.#now().toISOString(),
    };
    this.#state.users.push(user);
    return this.#startSession(user);
  }

  async login(input: unknown): Promise<AuthResponse> {
    const body = parseOrThrow(LoginBody, input, 'body');
    const user = this.#state.users.find((candidate) => candidate.email === body.email);
    // Unknown email and wrong password answer alike (F-15).
    if (user === undefined || !(await verifyPassword(body.password, user.salt, user.passwordHash))) {
      throw new DemoProblem(401, 'invalid-credentials', 'Email or password is incorrect.');
    }
    return this.#startSession(user);
  }

  async logout(): Promise<void> {
    const me = this.#requireUser();
    this.#state.sessionUserId = null;
    this.#csrfToken = null;
    await this.#save();
    this.#realtime.endSession(me.id);
  }

  // --- profile and users ------------------------------------------------------------------------------------------

  me(): MeResponse {
    return MeResponse.parse({ user: this.#publicUser(this.#requireUser()) });
  }

  async updateMe(input: unknown): Promise<MeResponse> {
    const user = this.#requireUser();
    const { bio } = parseOrThrow(UpdateMeBody, input, 'body');
    user.bio = bio;
    await this.#save();
    return this.me();
  }

  search(query: unknown): SearchResponse {
    const me = this.#requireUser();
    const { q, limit } = parseOrThrow(SearchQuery, query, 'query');
    const prefix = q.toLowerCase();
    const items = this.#state.users
      .filter(
        (user) =>
          user.id !== me.id &&
          [user.firstName, user.lastName, `${user.firstName} ${user.lastName}`].some((name) =>
            name.toLowerCase().startsWith(prefix),
          ),
      )
      .sort(compareByName)
      .slice(0, limit)
      .map((user) => this.#summary(user));
    return SearchResponse.parse({ items });
  }

  profile(idParam: unknown): UserProfileResponse {
    const me = this.#requireUser();
    const user = this.#userOrThrow(parseOrThrow(IdParam, idParam, 'params'));
    const state: RelationshipState = user.id === me.id ? 'self' : this.#relationship(me.id, user.id);
    const canSeeWall = state === 'self' || state === 'friends';
    return UserProfileResponse.parse({
      user: this.#publicUser(user),
      relationship: { state, canViewWall: canSeeWall, canPostOnWall: canSeeWall },
    });
  }

  // --- avatars ----------------------------------------------------------------------------------------------------

  /** `PUT /api/me/avatar`: one file in field `avatar`, no other parts, checked like the API's pipeline (ADR-0010). */
  async uploadAvatar(form: FormData): Promise<MeResponse> {
    const user = this.#requireUser();
    const parts = [...form.entries()];
    const file = form.get(AVATAR_FIELD);
    if (!(file instanceof Blob)) throw new DemoProblem(400, 'file-required', 'Choose an image to upload.');
    if (parts.length !== 1) throw new DemoProblem(400, 'invalid-request', 'Send exactly one file in "avatar".');
    if (file.size > AVATAR_MAX_BYTES)
      throw new DemoProblem(
        413,
        'file-too-large',
        `The image is larger than ${formatCount(AVATAR_MAX_BYTES / 1024 / 1024)} MB.`,
      );
    const contentType = sniffImageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    const size = contentType === null ? null : await this.#measureImage(file);
    if (contentType === null || size === null) {
      throw new DemoProblem(415, 'unsupported-media-type', 'Use a JPEG, PNG, WebP or GIF image.');
    }
    if (
      size.width > AVATAR_MAX_SIDE_PX ||
      size.height > AVATAR_MAX_SIDE_PX ||
      size.width * size.height > AVATAR_MAX_PIXELS
    ) {
      throw new DemoProblem(422, 'validation-failed', 'The image is too large.', [
        {
          location: 'file',
          path: AVATAR_FIELD,
          message: `Use an image of at most ${formatCount(AVATAR_MAX_SIDE_PX)} pixels per side.`,
        },
      ]);
    }
    await this.#persistence.saveAvatar(user.id, new Blob([file], { type: contentType }));
    user.avatar = { kind: 'upload', version: this.#randomUUID(), contentType };
    await this.#save();
    return this.me();
  }

  /** `GET /api/users/:id/avatar`: the current image, 404 when the user has none. */
  async avatar(idParam: unknown): Promise<AvatarImage> {
    this.#requireUser();
    const user = this.#userOrThrow(parseOrThrow(IdParam, idParam, 'params'));
    const { avatar } = user;
    if (avatar === null) throw new DemoProblem(404, 'not-found', 'Avatar was not found.');
    if (avatar.kind === 'design') return { body: renderAvatarSvg(avatar.design), contentType: 'image/svg+xml' };
    const image = await this.#persistence.loadAvatar(user.id);
    if (image === undefined) throw new DemoProblem(404, 'not-found', 'Avatar was not found.');
    return { body: image, contentType: avatar.contentType };
  }

  // --- friendships ------------------------------------------------------------------------------------------------

  friendships(): FriendshipsResponse {
    const me = this.#requireUser();
    // Friends since the acceptance, requests since they were sent.
    const entries = (rows: DemoFriendship[], other: (row: DemoFriendship) => number) =>
      rows
        .map((row) => ({ user: this.#userOrThrow(other(row)), row }))
        .sort((a, b) => compareByName(a.user, b.user))
        .map(({ user, row }) => ({ user: this.#summary(user), since: row.acceptedAt ?? row.createdAt }));
    const mine = this.#state.friendships.filter((row) => row.requesterId === me.id || row.addresseeId === me.id);
    const otherThanMe = (row: DemoFriendship) => (row.requesterId === me.id ? row.addresseeId : row.requesterId);
    return FriendshipsResponse.parse({
      friends: entries(
        mine.filter((row) => row.status === 'accepted'),
        otherThanMe,
      ),
      incoming: entries(
        mine.filter((row) => row.status === 'pending' && row.addresseeId === me.id),
        (row) => row.requesterId,
      ),
      outgoing: entries(
        mine.filter((row) => row.status === 'pending' && row.requesterId === me.id),
        (row) => row.addresseeId,
      ),
    });
  }

  async sendFriendRequest(input: unknown): Promise<FriendshipChange> {
    const me = this.#requireUser();
    const { userId } = parseOrThrow(SendFriendRequestBody, input, 'body');
    if (userId === me.id) throw new DemoProblem(422, 'cannot-befriend-self', 'You cannot add yourself as a friend.');
    this.#userOrThrow(userId);
    if (this.#friendship(me.id, userId) !== undefined) {
      throw new DemoProblem(409, 'friendship-exists', 'There is already a friendship or request.');
    }
    this.#state.friendships.push({
      requesterId: me.id,
      addresseeId: userId,
      status: 'pending',
      createdAt: this.#now().toISOString(),
      acceptedAt: null,
    });
    await this.#save();
    return this.#announceFriendship(me.id, userId);
  }

  /** `POST /api/friendships/:userId/accept`: the visitor accepts the request `userId` sent them. */
  async acceptFriendRequest(requesterIdParam: unknown): Promise<FriendshipChange> {
    const me = this.#requireUser();
    return this.acceptRequestAs(me.id, parseOrThrow(IdParam, requesterIdParam, 'params'));
  }

  /** `addresseeId` accepts the pending request of `requesterId` (the visitor, or a simulated person accepting theirs). */
  async acceptRequestAs(addresseeId: number, requesterId: number): Promise<FriendshipChange> {
    const row = this.#friendship(requesterId, addresseeId);
    if (row?.status !== 'pending' || row.addresseeId !== addresseeId) {
      throw new DemoProblem(404, 'friend-request-not-found', 'This friend request does not exist.');
    }
    row.status = 'accepted';
    row.acceptedAt = this.#now().toISOString();
    await this.#save();
    return this.#announceFriendship(addresseeId, requesterId);
  }

  /** Cancel, decline or unfriend: removes the row between the visitor and `userId` (404 when there is none). */
  async removeFriendship(userIdParam: unknown): Promise<FriendshipChange> {
    const me = this.#requireUser();
    const userId = parseOrThrow(IdParam, userIdParam, 'params');
    const row = this.#friendship(me.id, userId);
    if (row === undefined) throw new DemoProblem(404, 'friendship-not-found', 'This friendship does not exist.');
    this.#state.friendships.splice(this.#state.friendships.indexOf(row), 1);
    await this.#save();
    if (row.status === 'accepted') {
      // An ex-friend's sockets stop receiving the other's wall events at once (B-39).
      this.#realtime.leaveWall(me.id, userId);
      this.#realtime.leaveWall(userId, me.id);
    }
    return this.#announceFriendship(me.id, userId);
  }

  /** Whether `requesterId`'s request to `addresseeId` is still open (the simulation accepts only open ones). */
  hasPendingRequest(requesterId: number, addresseeId: number): boolean {
    const row = this.#friendship(requesterId, addresseeId);
    return row?.status === 'pending' && row.requesterId === requesterId;
  }

  // --- wall -------------------------------------------------------------------------------------------------------

  wall(idParam: unknown, query: unknown): WallPage {
    const me = this.#requireUser();
    const owner = this.#userOrThrow(parseOrThrow(IdParam, idParam, 'params'));
    const page = parseOrThrow(PageQuery, query, 'query');
    if (!this.#canSeeWall(me.id, owner.id)) {
      throw new DemoProblem(403, 'wall-forbidden', 'Only friends can see this wall.');
    }
    const { items, nextCursor } = pageNewestFirst(
      this.#state.posts.filter((post) => post.wallOwnerId === owner.id),
      page,
    );
    return WallPage.parse({ items: items.map((post) => this.#wallPost(post)), nextCursor });
  }

  async createPost(idParam: unknown, input: unknown): Promise<CreatePostResponse> {
    const me = this.#requireUser();
    const owner = this.#userOrThrow(parseOrThrow(IdParam, idParam, 'params'));
    const { body } = parseOrThrow(CreatePostBody, input, 'body');
    if (!this.#canSeeWall(me.id, owner.id)) {
      throw new DemoProblem(403, 'wall-write-forbidden', 'Only friends can write on this wall.');
    }
    const post: DemoPost = {
      id: this.#nextId('posts'),
      wallOwnerId: owner.id,
      authorId: me.id,
      body,
      createdAt: this.#now().toISOString(),
    };
    this.#state.posts.push(post);
    await this.#save();
    const response = CreatePostResponse.parse({ post: this.#wallPost(post) });
    this.#realtime.emit({ kind: 'wall', ownerId: owner.id }, 'wall:post-created', response.post);
    return response;
  }

  async deletePost(idParam: unknown): Promise<void> {
    const me = this.#requireUser();
    const id = parseOrThrow(IdParam, idParam, 'params');
    const post = this.#state.posts.find((candidate) => candidate.id === id);
    if (post === undefined) throw new DemoProblem(404, 'post-not-found', 'This post does not exist.');
    if (!canDeleteWallPost(me.id, { wallOwnerId: post.wallOwnerId, author: { id: post.authorId } })) {
      throw new DemoProblem(403, 'post-delete-forbidden', 'You can only delete your own posts or posts on your wall.');
    }
    this.#state.posts.splice(this.#state.posts.indexOf(post), 1);
    await this.#save();
    this.#realtime.emit({ kind: 'wall', ownerId: post.wallOwnerId }, 'wall:post-deleted', {
      id: post.id,
      wallOwnerId: post.wallOwnerId,
    });
  }

  /** `wall:join`: `not-found` for an unknown user, `forbidden` unless self or friends (B-39). */
  canJoinWall(userId: number): 'ok' | 'not-found' | 'forbidden' {
    const me = this.#requireUser();
    if (this.#findUser(userId) === undefined) return 'not-found';
    return this.#canSeeWall(me.id, userId) ? 'ok' : 'forbidden';
  }

  // --- chat -------------------------------------------------------------------------------------------------------

  chat(query: unknown): ChatPage {
    this.#requireUser();
    const page = parseOrThrow(PageQuery, query, 'query');
    const { items, nextCursor } = pageNewestFirst(this.#state.messages, page);
    return ChatPage.parse({ items: items.map((message) => this.#chatMessage(message)), nextCursor });
  }

  /** `chat:send` from the visitor; the payload is checked with `SendChatMessage` like the socket handler does. */
  async sendChat(payload: unknown): Promise<ChatMessage> {
    const me = this.#requireUser();
    const { body } = parseOrThrow(SendChatMessage, payload, 'body');
    return this.postChatAs(me.id, body);
  }

  /** A chat message by any user (the visitor, or a simulated person replying), sent to every socket. */
  async postChatAs(authorId: number, body: string): Promise<ChatMessage> {
    this.#userOrThrow(authorId);
    const message: DemoMessage = {
      id: this.#nextId('messages'),
      authorId,
      body,
      createdAt: this.#now().toISOString(),
    };
    this.#state.messages.push(message);
    await this.#save();
    const dto = ChatMessage.parse(this.#chatMessage(message));
    this.#realtime.emit({ kind: 'all' }, 'chat:message', dto);
    return dto;
  }

  // --- presence ---------------------------------------------------------------------------------------------------

  presence(): PresenceResponse {
    const me = this.#requireUser();
    const items = [...this.#online]
      .filter((id) => id !== me.id)
      .map((id) => this.#userOrThrow(id))
      .sort(compareByName)
      .map((user) => this.#summary(user));
    return PresenceResponse.parse({ items });
  }

  isOnline(userId: number): boolean {
    return this.#online.has(userId);
  }

  /** A simulated person comes online or goes offline; everyone else hears about it (F-87). */
  setOnline(userId: number, online: boolean): void {
    const user = this.#userOrThrow(userId);
    if (online === this.#online.has(userId)) return;
    if (online) {
      this.#online.add(userId);
      this.#realtime.emit({ kind: 'all' }, 'presence:joined', this.#summary(user));
    } else {
      this.#online.delete(userId);
      this.#realtime.emit({ kind: 'all' }, 'presence:left', { userId });
    }
  }

  userIdByEmail(email: string): number | undefined {
    return this.#state.users.find((user) => user.email === email)?.id;
  }

  /** Every user but the visitor, for the simulation to pick people from. */
  otherUserIds(): number[] {
    const me = this.sessionUserId();
    return this.#state.users.filter((user) => user.id !== me).map((user) => user.id);
  }

  /**
   * Takes over the state another tab of this browser stored (sync.ts), so tabs do not overwrite each other's changes
   * with an outdated copy. The object is updated in place; the CSRF token stays, as a session cookie would.
   */
  adopt(next: DemoState): void {
    Object.assign(this.#state, next);
  }

  // --- helpers ----------------------------------------------------------------------------------------------------

  #findUser(id: number): DemoUser | undefined {
    return this.#state.users.find((user) => user.id === id);
  }

  #userOrThrow(id: number): DemoUser {
    const user = this.#findUser(id);
    if (user === undefined) throw new DemoProblem(404, 'user-not-found', 'This user does not exist.');
    return user;
  }

  #friendship(a: number, b: number): DemoFriendship | undefined {
    return this.#state.friendships.find(
      (row) => (row.requesterId === a && row.addresseeId === b) || (row.requesterId === b && row.addresseeId === a),
    );
  }

  /** The friendship state between `viewerId` and `otherId`, from the viewer's side. */
  #relationship(viewerId: number, otherId: number): FriendshipState {
    const row = this.#friendship(viewerId, otherId);
    if (row === undefined) return 'none';
    if (row.status === 'accepted') return 'friends';
    return row.requesterId === viewerId ? 'pending_outgoing' : 'pending_incoming';
  }

  #canSeeWall(viewerId: number, ownerId: number): boolean {
    return viewerId === ownerId || this.#relationship(viewerId, ownerId) === 'friends';
  }

  /** `friendship:changed` to both people, each with the state from their own side (API.md §3). */
  #announceFriendship(actorId: number, otherId: number): FriendshipChange {
    const forActor = FriendshipChange.parse({ userId: otherId, state: this.#relationship(actorId, otherId) });
    this.#realtime.emit({ kind: 'user', userId: actorId }, 'friendship:changed', forActor);
    this.#realtime.emit({ kind: 'user', userId: otherId }, 'friendship:changed', {
      userId: actorId,
      state: this.#relationship(otherId, actorId),
    });
    return forActor;
  }

  #summary(user: DemoUser): UserSummary {
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatar === null ? null : `/api/users/${String(user.id)}/avatar?v=${user.avatar.version}`,
    };
  }

  #publicUser(user: DemoUser): PublicUser {
    return { ...this.#summary(user), bio: user.bio };
  }

  #wallPost(post: DemoPost): WallPost {
    return {
      id: post.id,
      wallOwnerId: post.wallOwnerId,
      author: this.#summary(this.#userOrThrow(post.authorId)),
      body: post.body,
      createdAt: post.createdAt,
    };
  }

  #chatMessage(message: DemoMessage): ChatMessage {
    return {
      id: message.id,
      author: this.#summary(this.#userOrThrow(message.authorId)),
      body: message.body,
      createdAt: message.createdAt,
    };
  }

  #nextId(table: keyof DemoState['lastIds']): number {
    this.#state.lastIds[table] += 1;
    return this.#state.lastIds[table];
  }

  #save(): Promise<void> {
    return this.#persistence.save(this.#state);
  }
}
