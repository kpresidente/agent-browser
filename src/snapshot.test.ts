import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { getEnhancedSnapshot } from './snapshot.js';

describe('getEnhancedSnapshot', () => {
  it('uses a temporary focus guard around _snapshotForAI', async () => {
    const evaluate = vi.fn().mockResolvedValue(undefined);
    const snapshotForAI = vi.fn().mockResolvedValue({
      full: '- menu [ref=e1]:\n  - menuitem "Edit" [ref=e2]',
    });

    const page = {
      evaluate,
      _snapshotForAI: snapshotForAI,
      locator: vi.fn(),
    } as unknown as Page;

    const result = await getEnhancedSnapshot(page);

    expect(snapshotForAI).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(result.tree).toContain('menuitem "Edit"');
    expect(result.refs.e2).toMatchObject({
      role: 'menuitem',
      name: 'Edit',
    });
  });

  it('cleans up focus guard and falls back to ariaSnapshot on _snapshotForAI failure', async () => {
    const evaluate = vi.fn().mockResolvedValue(undefined);
    const snapshotForAI = vi.fn().mockRejectedValue(new Error('snapshot failed'));
    const ariaSnapshot = vi.fn().mockResolvedValue('- button "Submit"');
    const locator = vi.fn().mockReturnValue({ ariaSnapshot });

    const page = {
      evaluate,
      _snapshotForAI: snapshotForAI,
      locator,
    } as unknown as Page;

    const result = await getEnhancedSnapshot(page);

    expect(snapshotForAI).toHaveBeenCalledTimes(1);
    expect(locator).toHaveBeenCalledWith(':root');
    expect(ariaSnapshot).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(result.tree).toContain('button "Submit"');
  });

  it('does not install focus guard for selector-scoped snapshots', async () => {
    const evaluate = vi.fn();
    const ariaSnapshot = vi.fn().mockResolvedValue('- heading "Main"');
    const locator = vi.fn().mockReturnValue({ ariaSnapshot });

    const page = {
      evaluate,
      locator,
    } as unknown as Page;

    const result = await getEnhancedSnapshot(page, { selector: '#main' });

    expect(locator).toHaveBeenCalledWith('#main');
    expect(ariaSnapshot).toHaveBeenCalledTimes(1);
    expect(evaluate).not.toHaveBeenCalled();
    expect(result.tree).toContain('heading "Main"');
  });
});
