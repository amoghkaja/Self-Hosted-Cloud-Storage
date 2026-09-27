import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect } from 'vitest';
import { TooltipProvider } from '../components/ui';

/** Fails the test on any WCAG violation axe can detect in jsdom (contrast needs a real browser). */
export async function expectAccessible(container: Element) {
  const result = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(
    result.violations.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
    ),
  ).toEqual([]);
}

export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [route] });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  };
}

/** Minimal fetch mock: route by "METHOD path" to JSON responses. */
export function mockFetch(
  routes: Record<string, (body: unknown) => { status?: number; json: unknown }>,
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace('/api/v1', '');
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    if (!handler)
      return new Response(
        JSON.stringify({ code: 'NOT_FOUND', detail: `no mock for ${method} ${path}` }),
        { status: 404 },
      );
    const res = handler(body);
    return new Response(JSON.stringify(res.json), {
      status: res.status ?? 200,
      headers: {
        'content-type':
          res.status && res.status >= 400 ? 'application/problem+json' : 'application/json',
      },
    });
  }) as typeof fetch;
  return calls;
}
