import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { Value } from '@needware/ir-types/Value';
import { supported } from '../../renderer/src/registry';

let channel: MessagePort | undefined;
const inputs: Record<string, Value> = {};
function fire(node: ViewNode) {
  if (!node.action) return;
  channel?.postMessage({ action: node.action, values: { ...inputs, record_id: { type: 'string', value: node.record ?? crypto.randomUUID() } } });
}
function Node({ node }: { node: ViewNode }) {
  const children = node.children.map(child => <Node key={child.id} node={child} />);
  switch (node.kind) {
    case 'heading': return <h2>{node.text}</h2>;
    case 'text': return <p>{node.text}</p>;
    case 'button': return <button type="button" onClick={() => fire(node)}>{node.text}</button>;
    case 'divider': return <hr />;
    case 'spacer': return <div className="spacer" aria-hidden="true" />;
    case 'text_input': case 'numeric_input': case 'date_input': case 'datetime_input': case 'textarea': {
      const field = node.field;
      if (!field) return <p role="alert">Input is missing its field binding.</p>;
      const onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (node.kind === 'datetime_input') { const date = new Date(event.target.value); if (!Number.isNaN(date.valueOf())) inputs[field] = { type: 'datetime', value: date.toISOString() }; }
        else inputs[field] = { type: node.kind === 'numeric_input' ? 'integer' : node.kind === 'date_input' ? 'date' : 'string', value: event.target.value };
      };
      return <label htmlFor={node.id}>{node.text}{node.kind === 'textarea' ? <textarea id={node.id} onChange={onChange} /> : <input id={node.id} type={node.kind === 'numeric_input' ? 'number' : node.kind === 'date_input' ? 'date' : node.kind === 'datetime_input' ? 'datetime-local' : 'text'} onChange={onChange} />}</label>;
    }
    case 'list': return children.length ? <div className="list">{children}</div> : <p className="empty">Nothing here yet. Add your first item.</p>;
    case 'row': return <div className="row">{children}</div>;
    case 'grid': return <div className="grid">{children}</div>;
    case 'card': return <section className="card">{children}</section>;
    case 'alert': return <p role="alert">{node.text}</p>;
    case 'badge': case 'stat': return <strong>{node.text}</strong>;
    default: return <div>{node.text}{children}</div>;
  }
}
function validView(node: ViewNode, count: { value: number }, depth = 0): boolean {
  if (!node || typeof node.id !== 'string' || typeof node.text !== 'string' || !Array.isArray(node.children) || !supported.has(node.kind) || depth > 32 || ++count.value > 4096) return false;
  return node.children.every(child => validView(child, count, depth + 1));
}
const element = document.getElementById('root');
if (!element) throw new Error('Missing trusted renderer root');
const root = createRoot(element);
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.kind !== 'needware-connect' || !event.ports[0] || channel) return;
  channel = event.ports[0];
  channel.onmessage = event => {
    const view = event.data as ViewNode;
    root.render(validView(view, { value: 0 }) ? <Node node={view} /> : <p role="alert">This application uses unsupported or invalid components. Execution stopped.</p>);
  };
  channel.start();
});
window.parent.postMessage({ kind: 'needware-ready' }, '*');
