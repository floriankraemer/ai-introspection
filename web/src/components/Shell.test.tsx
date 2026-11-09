import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderApp } from '../test-utils.js';

const html = document.documentElement;
const select = () => screen.findByRole('combobox', { name: 'Theme' });

afterEach(() => {
  localStorage.clear();
  html.removeAttribute('data-theme');
});

describe('theme select', () => {
  it('shows the stored preference and applies it to the page', async () => {
    localStorage.setItem('introspect.theme', 'dark');
    renderApp('/');
    expect(await select()).toHaveValue('dark');
    expect(html).toHaveAttribute('data-theme', 'dark');
  });

  it('follows prefers-color-scheme when System is chosen', async () => {
    localStorage.setItem('introspect.theme', 'light');
    const user = userEvent.setup();
    renderApp('/');
    expect(await select()).toHaveValue('light');
    expect(html).toHaveAttribute('data-theme', 'light');
    await user.selectOptions(await select(), 'system');
    expect(html).not.toHaveAttribute('data-theme');
    expect(localStorage.getItem('introspect.theme')).toBe('system');
  });

  it('defaults to System and picks up a change made in another tab', async () => {
    renderApp('/');
    expect(await select()).toHaveValue('system');
    localStorage.setItem('introspect.theme', 'dark');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'introspect.theme' }));
    });
    expect(await select()).toHaveValue('dark');
    expect(html).toHaveAttribute('data-theme', 'dark');
  });
});
