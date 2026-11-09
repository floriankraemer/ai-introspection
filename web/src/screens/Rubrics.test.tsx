import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-utils.js';

// The editor is a lazily loaded chunk and CodeMirror applies text asynchronously, so under load
// both the element and its content can lag the default 1 s timeout.
const SLOW = { timeout: 8000 };
const editor = () => screen.findByRole('textbox', { name: 'Rubric body (markdown)' }, SLOW);
const editorHas = (text: string) =>
  waitFor(() => {
    expect(screen.getByRole('textbox', { name: 'Rubric body (markdown)' })).toHaveTextContent(text);
  }, SLOW);

describe('Rubrics', () => {
  it('lists rubrics with their calibration gate and shows the selected one', async () => {
    renderApp('/rubrics');
    const nav = await screen.findByRole('navigation', { name: 'Rubrics' });
    expect(within(nav).getByTitle('Needs calibration: 7 of 10 agree')).toHaveTextContent(
      '7/10 agree · uncalibrated',
    );
    expect(within(nav).getAllByText('trusted')).toHaveLength(2);
    // The lazily loaded CodeMirror editor shows the file, frontmatter included.
    await editorHas('pass_threshold: 0.6');
    expect(screen.getByLabelText('Pass threshold')).toHaveValue(0.6);
  });

  it('saves a new version with a commit message, keeping threshold and frontmatter in step', async () => {
    const user = userEvent.setup();
    renderApp('/rubrics');
    const save = await screen.findByRole('button', { name: 'Save as v4 (commit)' });
    expect(save).toBeDisabled();
    await editor();

    const threshold = screen.getByLabelText('Pass threshold');
    await user.clear(threshold);
    await user.type(threshold, '0.8');
    await editorHas('pass_threshold: 0.8');
    const message = screen.getByLabelText('Commit message');
    await user.clear(message);
    await user.type(message, 'Raise the bar');
    await user.click(save);

    expect(await screen.findByText(/Saved as v4 and committed/)).toBeInTheDocument();
    // The whole file was sent, so the frontmatter survives the round trip.
    await editorHas('name: efficiency');
    await editorHas('pass_threshold: 0.8');
    expect(screen.getByRole('button', { name: 'Save as v5 (commit)' })).toBeDisabled();
    await user.click(screen.getByText(/History \(4 versions\)/));
    expect(screen.getByText(/Raise the bar/)).toBeInTheDocument();
  });

  it('rejects a threshold outside 0 to 1', async () => {
    const user = userEvent.setup();
    renderApp('/rubrics');
    const threshold = await screen.findByLabelText('Pass threshold');
    await user.clear(threshold);
    await user.type(threshold, '7');
    expect(screen.getByText('Use a number from 0 to 1.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save as v4/ })).toBeDisabled();
  });

  it('dry-runs the draft on the calibration sessions and lists the verdicts', async () => {
    const user = userEvent.setup();
    renderApp('/rubrics');
    await user.click(await screen.findByRole('button', { name: 'Dry-run on 10 sessions' }));
    const table = await screen.findByRole('table', { name: 'Dry-run results' });
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(screen.getByText(/Dry-run results · 6 of 10 pass/)).toBeInTheDocument();
    expect(screen.getByText(/Used 60k tokens. Nothing is saved/)).toBeInTheDocument();
  });

  it('shows the calibration table with disagreements and the 8 / 10 gate', async () => {
    const user = userEvent.setup();
    renderApp('/rubrics');
    const aside = await screen.findByRole('complementary', { name: 'Calibration' });
    expect(await within(aside).findByText('7 / 10')).toBeInTheDocument();
    expect(within(aside).getByText(/Needs calibration: 7 of 10 agree\./)).toBeInTheDocument();
    expect(within(aside).getAllByRole('row')).toHaveLength(1 + 4 + 1);
    await user.click(within(aside).getByRole('button', { name: '+ 6 more' }));
    expect(within(aside).getAllByRole('row')).toHaveLength(1 + 10);

    // A trusted rubric says so.
    await user.click(
      within(screen.getByRole('navigation', { name: 'Rubrics' })).getByText('redundant-tests'),
    );
    expect(await screen.findByText(/The improver may use this rubric\./)).toBeInTheDocument();
  });

  it('adds a calibration label for a session', async () => {
    const user = userEvent.setup();
    renderApp('/rubrics');
    const aside = await screen.findByRole('complementary', { name: 'Calibration' });
    await user.click(await within(aside).findByRole('button', { name: 'Add label…' }));
    await user.selectOptions(await within(aside).findByLabelText('Session to label'), 'sess-11');
    await user.click(within(aside).getByLabelText('Fail'));
    await user.click(within(aside).getByRole('button', { name: 'Save label' }));
    expect(await within(aside).findByText('7 / 11')).toBeInTheDocument();
    expect(within(aside).queryByRole('button', { name: 'Save label' })).not.toBeInTheDocument();
  });

  it('creates a new rubric', async () => {
    const user = userEvent.setup();
    renderApp('/rubrics');
    await user.click(await screen.findByRole('button', { name: '+ New rubric' }));
    await user.type(screen.getByLabelText('Rubric name'), 'Bad Name');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.clear(screen.getByLabelText('Rubric name'));
    await user.type(screen.getByLabelText('Rubric name'), 'security');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await within(screen.getByRole('navigation', { name: 'Rubrics' })).findByText('security'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Save as v2 (commit)' })).toBeInTheDocument();
  });

  it('points to Settings when there are no rubrics', async () => {
    renderApp('/rubrics', 'ungraded');
    expect(await screen.findByText('No rubrics in your skills repo yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /starter rubrics in Settings/ })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('explains the over-budget state when a dry-run is refused', async () => {
    const user = userEvent.setup();
    renderApp('/rubrics', 'overbudget');
    await user.click(await screen.findByRole('button', { name: 'Dry-run on 10 sessions' }));
    expect(
      await screen.findByText(/Dry-run failed: The daily token budget is used up/),
    ).toBeInTheDocument();
  });
});
