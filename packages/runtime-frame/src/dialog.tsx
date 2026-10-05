import React,{useEffect,useRef,type ReactNode} from 'react';
import type {ViewNode} from '@needware/ir-types/ViewNode';
export function RuntimeDialog({node,close,children}:{node:ViewNode;close:()=>void;children:ReactNode}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;if(!dialog)return;const previous=document.activeElement;
    if(dialog.open)dialog.close();if(node.open){if(node.active_overlay)dialog.showModal();else dialog.show();}
    return()=>{if(dialog.open)dialog.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
  },[node.open,node.active_overlay]);
  function trap(event:React.KeyboardEvent<HTMLDialogElement>){
    if(event.key!=='Tab'||!node.active_overlay)return;
    const items=[...event.currentTarget.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')].filter(item=>item.tabIndex>=0&&!item.matches(':disabled')&&!item.closest('[inert]')&&item.getClientRects().length>0);
    const first=items[0],last=items.at(-1);if(!first)return;
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
  return <dialog ref={ref} className={node.kind==='drawer'?'runtime-drawer':'runtime-modal'} aria-label={node.text||'Application dialog'} aria-modal={node.active_overlay} inert={!node.active_overlay} onKeyDown={trap} onCancel={event=>{event.preventDefault();if(node.active_overlay)close();}}><h2>{node.text||'Application dialog'}</h2><button type="button" onClick={close} aria-label={`Close ${node.text||'application dialog'}`}>Close</button>{children}</dialog>;
}
