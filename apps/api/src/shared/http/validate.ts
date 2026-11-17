import type { Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';

import { ValidationError, type ValidationIssue } from '../errors/app-error.js';

export interface RequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

export type ValidatedInput<S extends RequestSchemas> = {
  [K in keyof RequestSchemas]-?: S[K] extends z.ZodType ? z.output<S[K]> : undefined;
};

export type ValidatedHandler<S extends RequestSchemas> = (
  input: ValidatedInput<S>,
  req: Request,
  res: Response,
) => Promise<void> | void;

type RequestPart = keyof RequestSchemas;

const PARTS: readonly RequestPart[] = ['params', 'query', 'body'];

/** Parts that identify the resource: an issue here makes the whole request a 400 (ADR-0004). */
const IDENTIFYING_PARTS: ReadonlySet<RequestPart> = new Set(['params', 'query']);

function toIssues(part: RequestPart, error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    location: part,
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * ADR-0004: issues in params or query → 400 `invalid-request` (a broken request: the resource it names cannot
 * exist); issues only in the body → 422 `validation-failed` (a well-formed request with invalid content). Either
 * way every issue of every part is reported together in `errors[]`.
 */
function statusFor(failedParts: readonly RequestPart[]): 400 | 422 {
  return failedParts.some((part) => IDENTIFYING_PARTS.has(part)) ? 400 : 422;
}

/**
 * Validates params, query and body with Zod and hands the parsed, typed values to the handler. The handler is
 * never called when any part fails.
 *
 * Why a wrapper instead of mutating `req`: in Express 5 `req.query` is a getter and cannot be reassigned, and a
 * wrapper keeps the parsed types attached to the handler. No try/catch: Express 5 forwards the rejected promise
 * (the `ValidationError` or the handler's own error) to the error handler.
 */
export function validate<S extends RequestSchemas>(schemas: S, handler: ValidatedHandler<S>): RequestHandler {
  return async (req, res) => {
    const issues: ValidationIssue[] = [];
    const failedParts: RequestPart[] = [];
    const parsed: Partial<Record<RequestPart, unknown>> = {};

    for (const part of PARTS) {
      const schema = schemas[part];
      if (schema === undefined) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        parsed[part] = result.data;
      } else {
        failedParts.push(part);
        issues.push(...toIssues(part, result.error));
      }
    }

    if (failedParts.length > 0) throw new ValidationError(issues, { status: statusFor(failedParts) });
    // Every declared part parsed successfully, so `parsed` holds exactly the outputs `ValidatedInput<S>` describes.
    await handler(parsed as ValidatedInput<S>, req, res);
  };
}
