import './reader-core.js';
import { createCaptureManager } from './capture-manager.mjs';

const manager = createCaptureManager(chrome, globalThis.DashboardFootballReader);
const safe = promise => Promise.resolve(promise).catch(() => {});
function respond(promise, reply) { promise.then(reply, () => reply({ error: 'temporary_extension_failure' })); return true; }
chrome.runtime.onMessageExternal.addListener((message, sender, reply) => respond(manager.external(message, sender), reply));
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (['SOURCE_HELLO', 'SOURCE_RESULTS', 'SOURCE_FAILED'].includes(message?.type)) return respond(manager.source(message, sender), reply);
  if (['GET_RESULTS', 'REFRESH_RESULTS'].includes(message?.type)) return respond(manager.popup(message, sender), reply);
});
chrome.alarms.onAlarm.addListener(alarm => safe(manager.alarm(alarm)));
chrome.tabs.onActivated.addListener(info => safe(manager.activated(info)));
chrome.tabs.onUpdated.addListener((tabId, changes, tab) => safe(manager.updated(tabId, changes, tab)));
chrome.tabs.onRemoved.addListener(tabId => safe(manager.removed(tabId)));
chrome.runtime.onInstalled.addListener(() => safe(manager.startup()));
chrome.runtime.onStartup.addListener(() => safe(manager.startup()));
safe(manager.initialize());
