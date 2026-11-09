import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test-utils.js';

// CodeMirror needs real layout and selection events that happy-dom lacks; a textarea stands in.
vi.mock('../components/MarkdownEditor.js', () => ({
  default: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (v: string) => void;
    label: string;
  }) => (
    <textarea
      aria-label={label}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
      }}
    />
  ),
}));

const detail = () => screen.findByRole('region', { name: 'Proposal detail' });

describe('Proposals', () => {
  it('lists open proposals first with tabs, and shows the nav badge', async () => {
    const user = userEvent.setup();
    renderApp('/proposals');
    const list = await screen.findByRole('tab', { name: 'Open (3)' });
    expect(list).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('link', { name: /Proposals/ })).toHaveTextContent('3 open');
    const d = await detail();
    expect(
      await within(d).findByRole('heading', { name: /find the dev-server port/ }),
    ).toBeVisible();
    expect(within(d).getByRole('region', { name: 'Diff' })).toHaveTextContent(
      '+If the server fails',
    );
    expect(within(d).getByRole('link', { name: 'Add OAuth to API service' })).toHaveAttribute(
      'href',
      '/sessions/sess-1',
    );
    await user.click(within(d).getByRole('button', { name: '+ 10 more' }));
    expect(
      within(d).getAllByRole('link', {
        name: /Triage issue|Add OAuth|Fix|Write|Spawn|Refactor|Bump/,
      }).length,
    ).toBeGreaterThan(2);

    await user.click(screen.getByRole('tab', { name: /^Accepted/ }));
    expect(await screen.findByText('review skill: name the files it must read')).toBeVisible();
    expect(await screen.findByText(/Merged as commit/)).toHaveTextContent('9f3c2ab');
    await user.click(screen.getByRole('tab', { name: /Open/ }));
    await user.click(await screen.findByRole('button', { name: /changelog skill/ }));
    expect(await screen.findByRole('button', { name: 'Open pull request' })).toBeVisible();
  });

  it('merges a proposal and moves it out of Open', async () => {
    const user = userEvent.setup();
    renderApp('/proposals');
    await user.click(await screen.findByRole('button', { name: 'Merge into main' }));
    expect(await screen.findByText(/Merged as commit/)).toHaveTextContent('4be71d0');
    expect(await screen.findByRole('tab', { name: 'Open (2)' })).toBeVisible();
  });

  it('opens a pull request in PR mode and links it', async () => {
    const user = userEvent.setup();
    renderApp('/proposals');
    await user.click(await screen.findByRole('button', { name: /changelog skill/ }));
    await user.click(await screen.findByRole('button', { name: 'Open pull request' }));
    expect(await screen.findByText(/PR opened — waiting for merge/)).toBeVisible();
    expect(screen.getByRole('link', { name: /pull\/42/ })).toHaveAttribute(
      'href',
      'https://github.com/acme/web-app/pull/42',
    );
    // PR mode keeps the proposal open until the PR merges.
    expect(screen.getByRole('tab', { name: 'Open (3)' })).toBeVisible();
  });

  it('shows a 409 with its fix line, and a retry succeeds', async () => {
    const user = userEvent.setup();
    renderApp('/proposals');
    await user.click(await screen.findByRole('button', { name: /settings.json/ }));
    await user.click(await screen.findByRole('button', { name: 'Merge into main' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('uncommitted changes');
    expect(alert).toHaveTextContent('How to fix: Commit or stash the changes');
    await user.click(screen.getByRole('button', { name: 'Merge into main' }));
    expect(await screen.findByText(/Merged as commit/)).toBeVisible();
  });

  it('edits the diff and shows validation problems inline', async () => {
    const user = userEvent.setup();
    renderApp('/proposals');
    await user.click(await screen.findByRole('button', { name: 'Edit first' }));
    const editor = await screen.findByRole('textbox', { name: 'Diff (unified)' });
    expect((editor as HTMLTextAreaElement).value).toContain('+++ b/skills/e2e-testing/SKILL.md');
    await user.click(editor);
    await user.keyboard('x');
    await user.click(screen.getByRole('button', { name: 'Save diff' }));
    expect(await screen.findByRole('button', { name: 'Edit first' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Edit first' }));
    const again = await screen.findByRole('textbox', { name: 'Diff (unified)' });
    await user.click(again);
    // Breaking the file header makes the server-side validation fail.
    await user.clear(again);
    await user.type(again, 'just prose');
    await user.click(screen.getByRole('button', { name: 'Save diff' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The diff has no "+++ b/<path>" file header.');
    // The draft is kept so it can be fixed.
    expect(screen.getByRole('textbox', { name: 'Diff (unified)' })).toHaveValue('just prose');
  });

  it('rejects with a reason', async () => {
    const user = userEvent.setup();
    renderApp('/proposals');
    await user.click(await screen.findByRole('button', { name: 'Reject with reason…' }));
    const submit = screen.getByRole('button', { name: 'Reject proposal' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Reason for rejecting'), 'Not now');
    await user.click(submit);
    expect(await screen.findByText('Rejected: Not now')).toBeVisible();
    expect(await screen.findByRole('tab', { name: 'Open (2)' })).toBeVisible();
  });

  it('shows the last run and why a rubric was excluded', async () => {
    renderApp('/proposals');
    expect(await screen.findByText(/efficiency needs calibration — excluded/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Calibrate in Rubrics' })).toHaveAttribute(
      'href',
      '/rubrics',
    );
  });

  it('explains an improver that never ran, and run now reports the result', async () => {
    const user = userEvent.setup();
    renderApp('/proposals', 'noruns');
    expect(await screen.findByText('The improver has not run yet')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Run improver now' }));
    // The job is polled once a second before the lists refetch.
    const wait = { timeout: 4000 };
    expect(await screen.findByText('No open proposals', {}, wait)).toBeVisible();
    expect(
      await screen.findByText(/Last run Just now: succeeded, 0 proposals/, {}, wait),
    ).toBeVisible();
  });

  it('points to calibration when no rubric is trusted', async () => {
    renderApp('/proposals', 'ungraded');
    expect(await screen.findByText('No rubric is trusted yet')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Calibrate a rubric' })).toHaveAttribute(
      'href',
      '/rubrics',
    );
  });

  it('puts a conflicted proposal under Needs attention, and Rejected includes superseded', async () => {
    const user = userEvent.setup();
    renderApp('/proposals');
    await user.click(await screen.findByRole('tab', { name: 'Needs attention (1)' }));
    expect(await screen.findByText(/Merge conflict: the target changed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit first' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Rejected (1)' })).toBeVisible();
  });

  it('shows the next scheduled run', async () => {
    renderApp('/proposals');
    expect(await screen.findByText(/^Next run /)).toBeVisible();
  });
});
