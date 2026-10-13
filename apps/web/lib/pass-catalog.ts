export const passCatalog=[
 {id:'needware_pro_30_days',amount:49900,duration_days:30,label:'30 days'},
 {id:'needware_pro_365_days',amount:499000,duration_days:365,label:'365 days'},
] as const;
export type PassId=typeof passCatalog[number]['id'];
export function passDefinition(id:unknown){
 const plan=passCatalog.find(plan=>plan.id===id);
 if(!plan)throw new Error('Unknown Pro pass');
 return plan;
}
