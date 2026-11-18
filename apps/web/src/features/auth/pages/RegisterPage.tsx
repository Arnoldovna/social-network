import { RegisterBody } from '@app/shared';
import { useId } from 'react';
import { useNavigate } from 'react-router';

import { TextField } from '../../../shared/ui/TextField';
import { useRegisterMutation } from '../auth.api';
import { AuthForm, useAuthForm } from '../components/AuthForm';
import { WelcomeLinks } from '../components/WelcomeLinks';
import './RegisterPage.css';

/**
 * `/welcome` (F-06, F-09–F-13, F-96): the registration form. Every field has a visible label, the right `type` and
 * `autocomplete` (F-12, B-104), and its error as text (F-11, B-105). The values are checked with the shared
 * `RegisterBody` schema before anything is sent, so the form and the API apply the same rules (F-09). On success the
 * user is signed in (the mutation wrote the `getMe` cache) and lands on `/`; an existing email shows the F-10 sentence
 * next to the email field.
 */
export function RegisterPage() {
  const headingId = useId();
  const navigate = useNavigate();
  const [registerAccount] = useRegisterMutation();
  const { form, formError, busy, handleSubmit } = useAuthForm({
    schema: RegisterBody,
    defaultValues: { firstName: '', lastName: '', email: '', password: '' },
    send: (values) => registerAccount(values).unwrap(),
    onSuccess: () => navigate('/', { replace: true }),
  });
  const { errors } = form.formState;

  return (
    <div className="register-page">
      <title>Sign up · Let's chat!</title>
      <h1 id={headingId} className="register-page__title">
        Sign up
      </h1>
      <p className="register-page__intro">Create an account to find friends, write on their walls and join the chat.</p>
      <AuthForm
        labelledBy={headingId}
        onSubmit={handleSubmit}
        submitLabel="sign up"
        busyLabel="signing up…"
        busy={busy}
        formError={formError}
      >
        <TextField
          label="first name"
          autoComplete="given-name"
          required
          error={errors.firstName?.message}
          {...form.register('firstName')}
        />
        <TextField
          label="last name"
          autoComplete="family-name"
          required
          error={errors.lastName?.message}
          {...form.register('lastName')}
        />
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
          autoComplete="new-password"
          required
          hint="At least 12 characters."
          error={errors.password?.message}
          {...form.register('password')}
        />
      </AuthForm>
      <WelcomeLinks
        links={[
          { lead: 'Already a member?', to: '/welcome/login', label: 'log in' },
          { to: '/welcome/about', label: 'about' },
        ]}
      />
    </div>
  );
}
