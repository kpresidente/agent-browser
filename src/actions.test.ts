import { describe, it, expect, vi } from 'vitest';
import { executeCommand, toAIFriendlyError } from './actions.js';

describe('toAIFriendlyError', () => {
  describe('element blocked by overlay', () => {
    it('should detect intercepts pointer events even when Timeout is in message', () => {
      // This is the exact error from Playwright when a cookie banner blocks an element
      // Bug: Previously this was incorrectly reported as "not found or not visible"
      const error = new Error(
        'TimeoutError: locator.click: Timeout 10000ms exceeded.\n' +
          'Call log:\n' +
          "  - waiting for getByRole('link', { name: 'Anmelden', exact: true }).first()\n" +
          '    - locator resolved to <a href="https://example.com/login">Anmelden</a>\n' +
          '  - attempting click action\n' +
          '    2 x waiting for element to be visible, enabled and stable\n' +
          '      - element is visible, enabled and stable\n' +
          '      - scrolling into view if needed\n' +
          '      - done scrolling\n' +
          '      - <body class="font-sans antialiased">...</body> intercepts pointer events\n' +
          '    - retrying click action'
      );

      const result = toAIFriendlyError(error, '@e4');

      // Must NOT say "not found" - the element WAS found
      expect(result.message).not.toContain('not found');
      // Must indicate the element is blocked
      expect(result.message).toContain('blocked by another element');
      expect(result.message).toContain('modal or overlay');
    });

    it('should suggest dismissing cookie banners', () => {
      const error = new Error('<div class="cookie-overlay"> intercepts pointer events');
      const result = toAIFriendlyError(error, '@e1');

      expect(result.message).toContain('cookie banners');
    });
  });
});

describe('executeCommand click focus guard lifecycle', () => {
  it('arms focus guard before click', async () => {
    const click = vi.fn().mockResolvedValue(undefined);
    const getLocator = vi.fn().mockReturnValue({ click });
    const armSnapshotFocusGuard = vi.fn().mockResolvedValue(undefined);
    const clearSnapshotFocusGuard = vi.fn().mockResolvedValue(undefined);

    const browser = {
      getLocator,
      armSnapshotFocusGuard,
      clearSnapshotFocusGuard,
    } as any;

    const response = await executeCommand(
      {
        id: '1',
        action: 'click',
        selector: '@e1',
      } as any,
      browser
    );

    expect(response.success).toBe(true);
    expect(armSnapshotFocusGuard).toHaveBeenCalledTimes(1);
    expect(getLocator).toHaveBeenCalledWith('@e1');
    expect(click).toHaveBeenCalledTimes(1);
    expect(clearSnapshotFocusGuard).not.toHaveBeenCalled();
  });

  it('clears focus guard when click fails', async () => {
    const click = vi.fn().mockRejectedValue(new Error('click failed'));
    const getLocator = vi.fn().mockReturnValue({ click });
    const armSnapshotFocusGuard = vi.fn().mockResolvedValue(undefined);
    const clearSnapshotFocusGuard = vi.fn().mockResolvedValue(undefined);

    const browser = {
      getLocator,
      armSnapshotFocusGuard,
      clearSnapshotFocusGuard,
    } as any;

    const response = await executeCommand(
      {
        id: '2',
        action: 'click',
        selector: '@e2',
      } as any,
      browser
    );

    expect(response.success).toBe(false);
    expect(armSnapshotFocusGuard).toHaveBeenCalledTimes(1);
    expect(clearSnapshotFocusGuard).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'getbyrole',
      'getByRole',
      { action: 'getbyrole', role: 'button', name: 'More actions', subaction: 'click' },
      ['button', { name: 'More actions' }],
    ],
    [
      'getbytext',
      'getByText',
      { action: 'getbytext', text: 'More actions', exact: true, subaction: 'click' },
      ['More actions', { exact: true }],
    ],
    [
      'getbylabel',
      'getByLabel',
      { action: 'getbylabel', label: 'Search', subaction: 'click' },
      ['Search'],
    ],
    [
      'getbyplaceholder',
      'getByPlaceholder',
      { action: 'getbyplaceholder', placeholder: 'Search...', subaction: 'click' },
      ['Search...'],
    ],
    [
      'getbyalttext',
      'getByAltText',
      { action: 'getbyalttext', text: 'Icon', exact: false, subaction: 'click' },
      ['Icon', { exact: false }],
    ],
    [
      'getbytitle',
      'getByTitle',
      { action: 'getbytitle', text: 'More actions', exact: true, subaction: 'click' },
      ['More actions', { exact: true }],
    ],
    [
      'getbytestid',
      'getByTestId',
      { action: 'getbytestid', testId: 'menu-trigger', subaction: 'click' },
      ['menu-trigger'],
    ],
  ] as const)(
    'arms focus guard for %s click subaction',
    async (_name, pageMethod, command, expectedArgs) => {
      const click = vi.fn().mockResolvedValue(undefined);
      const locator = { click };
      const pageMethodFn = vi.fn().mockReturnValue(locator);
      const page = {
        [pageMethod]: pageMethodFn,
      } as any;

      const armSnapshotFocusGuard = vi.fn().mockResolvedValue(undefined);
      const clearSnapshotFocusGuard = vi.fn().mockResolvedValue(undefined);
      const browser = {
        getPage: vi.fn().mockReturnValue(page),
        armSnapshotFocusGuard,
        clearSnapshotFocusGuard,
      } as any;

      const response = await executeCommand(
        {
          id: 'find-click',
          ...command,
        } as any,
        browser
      );

      expect(response.success).toBe(true);
      expect(pageMethodFn).toHaveBeenCalledWith(...(expectedArgs as any));
      expect(armSnapshotFocusGuard).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(clearSnapshotFocusGuard).not.toHaveBeenCalled();
    }
  );

  it('arms focus guard for nth click subaction (first/last handlers)', async () => {
    const click = vi.fn().mockResolvedValue(undefined);
    const targetLocator = { click };
    const baseLocator = {
      last: vi.fn().mockReturnValue(targetLocator),
      nth: vi.fn().mockReturnValue(targetLocator),
    };
    const page = {
      locator: vi.fn().mockReturnValue(baseLocator),
    } as any;

    const armSnapshotFocusGuard = vi.fn().mockResolvedValue(undefined);
    const clearSnapshotFocusGuard = vi.fn().mockResolvedValue(undefined);
    const browser = {
      getPage: vi.fn().mockReturnValue(page),
      armSnapshotFocusGuard,
      clearSnapshotFocusGuard,
    } as any;

    const response = await executeCommand(
      {
        id: 'nth-click',
        action: 'nth',
        selector: 'button[title]',
        index: -1,
        subaction: 'click',
      } as any,
      browser
    );

    expect(response.success).toBe(true);
    expect(page.locator).toHaveBeenCalledWith('button[title]');
    expect(baseLocator.last).toHaveBeenCalledTimes(1);
    expect(armSnapshotFocusGuard).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(clearSnapshotFocusGuard).not.toHaveBeenCalled();
  });

  it('arms focus guard for dblclick and clears on failure', async () => {
    const dblclick = vi.fn().mockRejectedValue(new Error('dblclick failed'));
    const getLocator = vi.fn().mockReturnValue({ dblclick });
    const armSnapshotFocusGuard = vi.fn().mockResolvedValue(undefined);
    const clearSnapshotFocusGuard = vi.fn().mockResolvedValue(undefined);
    const browser = {
      getLocator,
      armSnapshotFocusGuard,
      clearSnapshotFocusGuard,
    } as any;

    const response = await executeCommand(
      {
        id: 'dbl1',
        action: 'dblclick',
        selector: '@e9',
      } as any,
      browser
    );

    expect(response.success).toBe(false);
    expect(armSnapshotFocusGuard).toHaveBeenCalledTimes(1);
    expect(clearSnapshotFocusGuard).toHaveBeenCalledTimes(1);
  });
});
