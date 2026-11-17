import { configureStore, createSlice } from '@reduxjs/toolkit';
import { screen } from '@testing-library/react';
import { useSelector } from 'react-redux';
import { Link, useLoaderData, useParams } from 'react-router';
import { describe, expect, it } from 'vitest';

import { MIRA } from '../../api/__tests__/fixtures';
import { meApi, useGetMeQuery } from '../../api/me.api';
import { apiUrl, HttpResponse, http, server } from '../msw';
import { renderRoutes, renderWithProviders } from '../render';

function CurrentUserName() {
  const { data } = useGetMeQuery(undefined);
  return <p>{data === undefined ? 'loading…' : data.user.firstName}</p>;
}

function ProfileId() {
  const { id = '' } = useParams();
  return (
    <>
      <p>profile {id}</p>
      <Link to="/chat">open chat</Link>
    </>
  );
}

describe('renderWithProviders', () => {
  it('provides the store, so RTK Query hooks work against MSW', async () => {
    server.use(http.get(apiUrl('/me'), () => HttpResponse.json({ user: MIRA })));

    const { store } = renderWithProviders(<CurrentUserName />);

    expect(await screen.findByText('Mira')).toBeInTheDocument();
    expect(meApi.endpoints.getMe.select(undefined)(store.getState()).data).toEqual({ user: MIRA });
  });

  it('renders at a route pattern with params and lets links navigate to extra routes', async () => {
    const { user, router } = renderWithProviders(<ProfileId />, {
      path: '/users/:id',
      initialEntries: ['/users/7'],
      routes: [{ path: '/chat', element: <p>chat page</p> }],
    });

    expect(screen.getByText('profile 7')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'open chat' }));

    expect(screen.getByText('chat page')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/chat');
  });

  it('uses the store a test passes in', () => {
    const greeting = createSlice({
      name: 'greeting',
      initialState: { text: 'hello from the test store' },
      reducers: {},
    });
    const store = configureStore({ reducer: { greeting: greeting.reducer } });
    function Greeting() {
      const text = useSelector((state: ReturnType<typeof store.getState>) => state.greeting.text);
      return <p>{text}</p>;
    }

    const rendered = renderWithProviders(<Greeting />, { store });

    expect(rendered.store).toBe(store);
    expect(screen.getByText('hello from the test store')).toBeInTheDocument();
  });
});

describe('renderRoutes', () => {
  it('runs loaders before rendering the route', async () => {
    function Loaded() {
      return <p>{useLoaderData<string>()}</p>;
    }

    renderRoutes([{ path: '/', loader: () => 'loaded by the loader', element: <Loaded /> }]);

    expect(await screen.findByText('loaded by the loader')).toBeInTheDocument();
  });
});

// The order matters: this test proves the previous ones left nothing in the document (setup.ts cleanup).
describe('setup', () => {
  it('unmounts what earlier tests rendered', () => {
    expect(document.body).toBeEmptyDOMElement();
  });
});
