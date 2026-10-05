import React,{useEffect,useSyncExternalStore} from 'react';
import type {ViewNode} from '@needware/ir-types/ViewNode';
import {base,decimalText,display,draftFor,initial,subscribe,snapshot,syncDraft,editDraft,acceptSaved,keepDraft,releaseDraft,scopeOf,type Raw} from './bindings';
export function RuntimeInput({node}:{node:ViewNode}){
  useSyncExternalStore(subscribe,snapshot);const draft=draftFor(node);
  useEffect(()=>syncDraft(node),[node]);
  const id=node.id,fieldName=node.field,scope=scopeOf(node);
  useEffect(()=>()=>releaseDraft(id,fieldName,scope),[id,fieldName,scope]);
  if(!node.field)return <p role="alert">Input is missing its field binding.</p>;
  function change(raw:Raw){editDraft(node,raw);}
  const field=node.input_contract,type=field&&base(field.data_type),scale=type?.type==='decimal'?type.scale:0;
  const bound=(value:string|null|undefined)=>value==null?undefined:decimalText(value,scale);
  const props={id:node.id,disabled:node.disabled,'aria-describedby':draft.invalid||draft.conflict?`${node.id}-review`:undefined,'aria-invalid':Boolean(draft.invalid),onChange:(event:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>change(event.target.value)};
  let control:React.ReactNode;
  if(node.kind==='checkbox'||node.kind==='toggle')control=<input {...props} type="checkbox" role={node.kind==='toggle'?'switch':undefined} checked={draft.raw===true} onChange={event=>change(event.target.checked)}/>;
  else if(node.kind==='radio')control=<fieldset disabled={node.disabled}><legend>{node.text}</legend>{node.options.map((option,index)=><label key={option}><input type="radio" name={node.id} value={option} checked={draft.raw===option} onChange={()=>change(option)} id={`${node.id}-${index}`}/>{option}</label>)}</fieldset>;
  else if(node.kind==='select'||node.kind==='multi_select')control=<select id={node.id} disabled={node.disabled} multiple={node.kind==='multi_select'} value={node.kind==='multi_select'?(Array.isArray(draft.raw)?draft.raw:[]):typeof draft.raw==='string'?draft.raw:''} onChange={event=>change(node.kind==='multi_select'?[...event.target.selectedOptions].map(option=>option.value):event.target.value)}>{node.kind==='select'&&<option value="">Choose an option</option>}{node.options.map(option=><option key={option}>{option}</option>)}</select>;
  else if(node.kind==='textarea')control=<textarea {...props} value={String(draft.raw)} maxLength={field?.max_length??undefined}/>;
  else control=<input {...props} type={node.kind==='slider'?'range':node.kind==='date_input'?'date':node.kind==='datetime_input'?'datetime-local':'text'} inputMode={node.kind==='numeric_input'?(scale?'decimal':'numeric'):undefined} value={String(draft.raw)} min={bound(field?.minimum)} max={bound(field?.maximum)} step={node.kind==='datetime_input'?'0.001':node.kind==='slider'?'1':undefined} maxLength={field?.max_length??undefined}/>;
  return <div className="runtime-field">{node.kind==='radio'?control:<><label htmlFor={node.id}>{node.text}{node.kind==='datetime_input'&&' (UTC)'}</label>{control}{node.kind==='slider'&&<output htmlFor={node.id}>{String(draft.raw)}</output>}</>}{draft.invalid&&<p role="alert" id={`${node.id}-review`}>{draft.invalid}</p>}{draft.conflict&&<section aria-label={`Review changed ${node.text}`} id={`${node.id}-review`}><p>The saved value changed while you were editing. Your draft is preserved.</p><button type="button" onClick={()=>acceptSaved(node)}>Use saved value</button><button type="button" onClick={()=>keepDraft(node)}>Keep my draft</button><p>Saved value: {String(display(initial(node)))}</p></section>}</div>;
}
