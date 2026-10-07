// Unknown modes fail closed. Omitting the setting preserves existing Stripe installations.
export function billingEnabled(environment:Record<string,string|undefined>=process.env){
  return billingProvider(environment)!=='disabled';
}
export function billingProvider(environment:Record<string,string|undefined>=process.env){const mode=environment.NEEDWARE_BILLING_MODE??'stripe';return mode==='stripe'||mode==='cashfree'?mode:'disabled';}
