import { createCaptureManager } from './capture-manager.mjs';

export function createMessageHandler(options) {
  const manager = createCaptureManager(options);
  const handle = manager.handle;
  for (const name of ['afterResponse', 'recover', 'handleAlarm', 'handleActivated', 'handleRemoved', 'idle']) handle[name] = manager[name];
  return handle;
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && chrome.storage?.session) {
  const ready = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  ready.catch(() => {});
  const handle = createMessageHandler({ extensionId: chrome.runtime.id, storage: chrome.storage.session,
    tabs: chrome.tabs, alarms: chrome.alarms, ready });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handle(message, sender).then(response => {
      sendResponse(response);
      // DONE/FAILURE are acknowledged before closing the sending tab.
      if (response?.ok && ['MYABACUS_DONE', 'MYABACUS_FAILURE', 'MYABACUS_STOP'].includes(message?.type)) void handle.afterResponse(message, sender);
    });
    return true;
  });
  chrome.alarms?.onAlarm.addListener(alarm => { void handle.handleAlarm(alarm); });
  chrome.tabs?.onActivated.addListener(info => { void handle.handleActivated(info); });
  chrome.tabs?.onRemoved.addListener(tabId => { void handle.handleRemoved(tabId); });
  void handle.recover();
}
