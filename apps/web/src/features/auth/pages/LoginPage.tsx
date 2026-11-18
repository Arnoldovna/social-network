import { LoginBody } from '@app/shared';
import { useId } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { messageFor } from '../../../shared/api/problem';
import { TextField } from '../../../shared/ui/TextField';
import { useLoginMutation } from '../auth.api';
import { WELCOME_ABOUT_PATH } from '../../../shared/lib/paths';
import { AuthForm, useAuthForm } from '../components/AuthForm';
import { WelcomeLinks } from '../components/WelcomeLinks';
import './LoginPage.css';

/** F-22: "Your session has expired. Please log in again.", the same sentence the API client uses for a 401. */
const SESSION_EXPIRED_MESSAGE = messageFor('unauthorized');

/**
 * `/welcome/login` (F-14, F-11–F-13, F-22, F-96). The session listener sends an expired session here with
 * `?reason=expired`, which shows the F-22 message above the form (ADR-0012); a visitor who simply opens the page never
 * sees it. Wrong email and wrong password get the same message (F-15). On success the user lands on `/`.
 */
export function LoginPage() {
  const headingId = useId();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sessionExpired = searchParams.get('reason') === 'expired';
  const [login] = useLoginMutation();
  const { form, formError, busy, handleSubmit } = useAuthForm({
    schema: LoginBody,
    defaultValues: { email: '', password: '' },
    send: (values) => login(values).unwrap(),
    onSuccess: () => navigate('/', { replace: true }),
  });
  const { errors } = form.formState;

  return (
    <div className="login-page">
      <title>Log in · Let's chat!</title>
      <h1 id={headingId} className="login-page__title">
        Log in
      </h1>
      {sessionExpired ? (
        <p className="login-page__notice" role="alert">
          {SESSION_EXPIRED_MESSAGE}
        </p>
      ) : (
        <p className="login-page__intro">Log in with the email address you signed up with.</p>
      )}
      <AuthForm
        labelledBy={headingId}
        onSubmit={handleSubmit}
        submitLabel="log in"
        busyLabel="logging in…"
        busy={busy}
        formError={formError}
      >
        <TextField
          label="email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          error={errors.email?.message}
          {...form.register('email')}
        />
        <TextField
          label="password"
          type="password"
          autoComplete="current-password"
          required
          error={errors.password?.message}
          {...form.register('password')}
        />
      </AuthForm>
      <WelcomeLinks
        links={[
          { lead: 'Not a member yet?', to: '/welcome', label: 'sign up' },
          { to: WELCOME_ABOUT_PATH, label: 'about' },
        ]}
      />
    </div>
  );
}
