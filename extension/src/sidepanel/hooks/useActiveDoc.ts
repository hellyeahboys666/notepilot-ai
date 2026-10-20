import { useEffect, useState } from 'react';
import { docIdFromUrl } from '../../core/docParser';

export interface ActiveDoc {
  docId: string | null;
  tabId: number | null;
  /** False when the active tab is not a Google Doc (the panel keeps showing the last doc). */
  activeTabIsDoc: boolean;
}

/**
 * Follows the Google Doc in the active tab of this panel's window. `?doc=<id>` pins the panel to
 * one document (used by "open in tab" and by the end-to-end tests).
 */
export function useActiveDoc(): ActiveDoc {
  const pinned = new URLSearchParams(location.search).get('doc');
  const [state, setState] = useState<ActiveDoc>({ docId: pinned, tabId: null, activeTabIsDoc: !!pinned });

  useEffect(() => {
    if (pinned) return;
    let windowId: number | undefined;
    let alive = true;

    const consider = (tab: chrome.tabs.Tab | undefined) => {
      if (!alive || !tab || (windowId !== undefined && tab.windowId !== windowId)) return;
      const id = docIdFromUrl(tab.url);
      setState((prev) =>
        id ? { docId: id, tabId: tab.id ?? null, activeTabIsDoc: true } : { ...prev, activeTabIsDoc: false },
      );
    };

    void (async () => {
      const win = await chrome.windows.getCurrent();
      windowId = win.id;
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      consider(tab);
    })();

    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (windowId !== undefined && info.windowId !== windowId) return;
      chrome.tabs.get(info.tabId).then(consider, () => undefined);
    };
    const onUpdated = (_id: number, change: { url?: string; status?: string }, tab: chrome.tabs.Tab) => {
      if (tab.active && (change.url || change.status === 'complete')) consider(tab);
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      alive = false;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [pinned]);

  return state;
}
