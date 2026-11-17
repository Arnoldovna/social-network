import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import type { SubmitEventHandler, ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import type { DefaultValues, FieldValues, Path } from 'react-hook-form';
import type { z } from 'zod';

import { Button } from '../../../shared/ui/Button';
import { FieldError } from '../../../shared/ui/FieldError';
import { authFormErrors } from '../auth.api';
import './AuthForm.css';

/**
 * Friendly sentences for the few rules of the shared schemas that carry no message of their own (the length caps, the
 * login password's "must not be empty"). Zod uses a schema's own message first, so every message the contract defines
 * (F-07–F-09, e.g. "Use at least 12 characters.") is shown exactly as written there; this only replaces Zod's
 * technical defaults ("Too big: expected string to have <=100 characters").
 */
const authFormErrorMap: z.core.$ZodErrorMap = (issue) => {
  if (issue.code === 'too_big' && issue.origin === 'string') {
    return `Use at most ${String(issue.maximum)} characters.`;
  }
  if (issue.code === 'too_small' && issue.origin === 'string') {
    return issue.path?.[0] === 'password' ? 'Please enter your password.' : 'Please fill in this field.';
  }
  return undefined;
};

/**
 * The form-level message of one failed attempt. `attempt` changes on every failure, so the same sentence twice in a
 * row (two wrong passwords) still mounts a new alert, which screen readers announce again, and moves the focus again.
 */
export interface AuthFormError {
  message: string;
  attempt: number;
}

export interface UseAuthFormOptions<Schema extends z.ZodType<FieldValues, FieldValues>> {
  /** The shared request schema (`RegisterBody`, `LoginBody`): the form checks exactly what the API checks (F-09). */
  schema: Schema;
  /** One entry per field; its keys are also the fields server errors may be mapped onto. */
  defaultValues: DefaultValues<z.input<Schema>>;
  /** Sends the parsed (trimmed, lower-cased) values; rejects with the `ApiError` of a failed request. */
  send: (values: z.output<Schema>) => Promise<unknown>;
  /** Runs after `send` resolved, usually the navigation to `/`. */
  onSuccess: () => Promise<void> | void;
}

/**
 * The state of a register or login form (F-11, F-13, ADR-0012): react-hook-form with the shared Zod schema, so an
 * invalid form is never sent; one request at a time; server answers mapped back onto the form.
 *
 * - Validation runs on submit, then on blur and on every change of a touched field (`onTouched`).
 * - A second submit while a request is in flight does nothing, also when it arrives before the re-render disabled the
 *   button (a fast double click), so double-clicking creates one account (F-13).
 * - A failed request puts its errors next to the fields (409 `email-taken`, 422) with focus on the first one, or into
 *   the form-level message (wrong credentials, 429, network). After success the form stays busy: the page is about to
 *   change, and the button must not invite another submit meanwhile.
 */
export function useAuthForm<Schema extends z.ZodType<FieldValues, FieldValues>>({
  schema,
  defaultValues,
  send,
  onSuccess,
}: UseAuthFormOptions<Schema>) {
  const form = useForm<z.input<Schema>, unknown, z.output<Schema>>({
    resolver: zodResolver(schema, { error: authFormErrorMap }),
    defaultValues,
    mode: 'onTouched',
  });
  const [formError, setFormError] = useState<AuthFormError | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const attempts = useRef(0);

  const sendValid = async (values: z.output<Schema>) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setFormError(null);
    try {
      await send(values);
    } catch (error: unknown) {
      const fieldNames = Object.keys(defaultValues) as Path<z.input<Schema>>[];
      const errors = authFormErrors(error, fieldNames);
      fieldNames
        .filter((name) => errors.fields[name] !== undefined)
        .forEach((name, index) => {
          form.setError(name, { type: 'server', message: errors.fields[name] }, { shouldFocus: index === 0 });
        });
      attempts.current += 1;
      setFormError(errors.form === null ? null : { message: errors.form, attempt: attempts.current });
      inFlight.current = false;
      setBusy(false);
      return;
    }
    await onSuccess();
  };

  // `handleSubmit` validates with the resolver first and calls `sendValid` only for a valid form (F-11). It is built
  // inside the event handler, so nothing that reads the refs above runs during render.
  const handleSubmit: SubmitEventHandler<HTMLFormElement> = (event) => {
    void form.handleSubmit(sendValid)(event);
  };

  return { form, formError, busy, handleSubmit };
}

export interface AuthFormProps {
  /** Id of the page heading, which names the form for assistive technology. */
  labelledBy: string;
  onSubmit: SubmitEventHandler<HTMLFormElement>;
  /** Lowercase, verb first ("sign up", "log in"). */
  submitLabel: string;
  /** Shown on the disabled button while the request runs ("signing up…"). */
  busyLabel: string;
  busy: boolean;
  /** The form-level message of a failed request, or `null`. */
  formError: AuthFormError | null;
  /** The `TextField`s. */
  children: ReactNode;
}

/**
 * The register and login form shell (F-11–F-13, B-104, B-105): a real `<form>`, so Enter submits; the browser's own
 * validation bubbles are off (`noValidate`) because every field shows the shared schema's message as text next to it,
 * linked with `aria-describedby` and marked `aria-invalid` by `TextField`. A form-level error is announced
 * (`role="alert"`) and, when the submit button had the focus (it was disabled while busy), receives the focus, so
 * keyboard users are not left on a dead control or at the top of the document.
 */
export function AuthForm({ labelledBy, onSubmit, submitLabel, busyLabel, busy, formError, children }: AuthFormProps) {
  const errorRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (formError === null) {
      return;
    }
    // Focus moves only when it was on the submit button (clicked, then disabled while busy) or already lost to the
    // document; Enter in a field keeps the caret where the user is typing.
    const focused = document.activeElement;
    if (focused === null || focused === document.body || focused === submitRef.current) {
      errorRef.current?.focus();
    }
  }, [formError]);

  return (
    <form
      className="auth-form"
      noValidate
      aria-labelledby={labelledBy}
      aria-busy={busy ? true : undefined}
      onSubmit={onSubmit}
    >
      <div className="auth-form__fields">{children}</div>
      {formError === null ? null : (
        <div key={formError.attempt} ref={errorRef} className="auth-form__error" tabIndex={-1}>
          <FieldError>{formError.message}</FieldError>
        </div>
      )}
      <Button ref={submitRef} type="submit" variant="outlined" className="auth-form__submit" disabled={busy}>
        {busy ? busyLabel : submitLabel}
      </Button>
    </form>
  );
}
