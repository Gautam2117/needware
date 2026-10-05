export function operatorAllowed(account:string,configured:string){
  const values=configured?configured.split(','):[];
  return values.length>0&&values.length<=16&&new Set(values).size===values.length&&values.every(value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))&&values.includes(account);
}
