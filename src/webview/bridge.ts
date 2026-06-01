import type { HostMsg, WebviewMsg } from '../shared/messages';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const _vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;

export function postToHost(msg: WebviewMsg): void {
  _vscode?.postMessage(msg);
}

export function onHostMessage(handler: (msg: HostMsg) => void): () => void {
  const listener = (event: MessageEvent) => handler(event.data as HostMsg);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
