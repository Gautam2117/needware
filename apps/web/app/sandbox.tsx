'use client';
import { useEffect, useRef } from 'react';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { Value } from '@needware/ir-types/Value';
import { frameEvent } from '../../../packages/browser-host/src/protocol';
export default function Sandbox({ title, document, view, dispatch, error }: {
  title: string; document: string; view: ViewNode;
  dispatch(action: string, values: Record<string, Value>): void; error(message: string): void;
}) {
  const port = useRef<MessagePort | null>(null);
  const latestView = useRef(view);
  const iframe = useRef<HTMLIFrameElement>(null);
  useEffect(() => { latestView.current = view; port.current?.postMessage(view); }, [view]);
  useEffect(() => () => { port.current?.close(); port.current = null; }, []);
  function connect() {
    port.current?.close(); const channel = new MessageChannel(); port.current = channel.port1;
    channel.port1.onmessage = event => {
      if (!frameEvent(event.data)) { error('Invalid application event was rejected.'); return; }
      dispatch(event.data.action, event.data.values);
    };
    channel.port1.start();
    iframe.current?.contentWindow?.postMessage({ kind: 'needware-connect' }, '*', [channel.port2]);
    channel.port1.postMessage(latestView.current);
  }
  // Load fires after the trusted inline renderer has installed its channel listener.
  return <iframe ref={iframe} title={`${title} application`} sandbox="allow-scripts" srcDoc={document} onLoad={connect} />;
}
