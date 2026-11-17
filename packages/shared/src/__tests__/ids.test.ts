import { describe, expect, it } from 'vitest';

import {
  ID_MAX,
  Id,
  IdParam,
  IdParams,
  intParam,
  SendFriendRequestBody,
  UserIdParams,
  WallRoomPayload,
} from '../index.js';

// B-55, F-42: path ids are digits only; F-112: ids in bodies and socket payloads are real JSON numbers.
describe('IdParam (path params)', () => {
  it.each([
    ['1', 1],
    ['42', 42],
    ['1000000000', 1_000_000_000],
    [String(ID_MAX), ID_MAX],
  ])('parses %j to %d', (input, expected) => {
    expect(IdParam.parse(input)).toBe(expected);
  });

  it.each(['abc', '0', '07', '-1', '1e3', '0x1F', ' 7', '7 ', '1.0', '1_000', '+7', '', '2147483648', '99999999999'])(
    'rejects %j',
    (input) => {
      expect(IdParam.safeParse(input).success).toBe(false);
    },
  );

  it.each([7, true, null, undefined, [7]])('rejects the non-string %j (Express path params are strings)', (input) => {
    expect(IdParam.safeParse(input).success).toBe(false);
  });

  it('is used by IdParams and UserIdParams', () => {
    expect(IdParams.parse({ id: '12' })).toEqual({ id: 12 });
    expect(UserIdParams.parse({ userId: '12' })).toEqual({ userId: 12 });
    expect(IdParams.safeParse({ id: 'me' }).success).toBe(false);
    expect(UserIdParams.safeParse({}).success).toBe(false);
  });
});

describe('Id (JSON bodies and socket payloads)', () => {
  it.each([1, 7, ID_MAX])('accepts the number %d', (input) => {
    expect(Id.parse(input)).toBe(input);
  });

  it.each([
    ['the string "7"', '7'],
    ['true', true],
    ['an array', [7]],
    ['zero', 0],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['a value above int32', ID_MAX + 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
  ])('rejects %s without coercion', (_label, input) => {
    expect(Id.safeParse(input).success).toBe(false);
  });

  it('is what SendFriendRequestBody and WallRoomPayload use', () => {
    expect(SendFriendRequestBody.parse({ userId: 3 })).toEqual({ userId: 3 });
    expect(SendFriendRequestBody.safeParse({ userId: '3' }).success).toBe(false);
    expect(WallRoomPayload.parse({ userId: 3 })).toEqual({ userId: 3 });
    expect(WallRoomPayload.safeParse({ userId: '3' }).success).toBe(false);
    expect(WallRoomPayload.safeParse(undefined).success).toBe(false);
    expect(WallRoomPayload.safeParse('3').success).toBe(false);
  });
});

describe('intParam (small query integers)', () => {
  const limit = intParam(1, 20);

  it.each([
    ['1', 1],
    ['20', 20],
    ['007', 7],
  ])('parses %j to %d', (input, expected) => {
    expect(limit.parse(input)).toBe(expected);
  });

  it.each(['0', '21', '1e1', '', ' 5', '-1', '2.5', '0x10', '1000', 'ten'])('rejects %j', (input) => {
    expect(limit.safeParse(input).success).toBe(false);
  });

  it('rejects repeated query keys, which Express parses into an array', () => {
    expect(limit.safeParse(['5', '6']).success).toBe(false);
  });
});
