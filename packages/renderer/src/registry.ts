import type { Component } from '@needware/ir-types/Component';
import type { Node } from '@needware/ir-types/Node';
export const supported = new Set<Component>(['text', 'heading', 'button', 'stack', 'row', 'grid', 'card', 'divider', 'spacer', 'list', 'text_input', 'numeric_input', 'date_input', 'datetime_input', 'textarea', 'badge', 'alert', 'empty_state', 'stat','modal','drawer','form','checkbox','toggle','radio','select','multi_select','slider','progress']);
export function requireSupported(node: Node): void {
  if (!supported.has(node.kind)) throw new Error(`Unsupported renderer component: ${node.kind}. Application did not start.`);
  for (const child of node.children) requireSupported(child);
}
