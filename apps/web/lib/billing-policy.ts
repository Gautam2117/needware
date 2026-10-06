// Unknown modes fail closed. Omitting the setting preserves existing Stripe installations.
export function billingEnabled(environment:Record<string,string|undefined>=process.env){
  return (environment.NEEDWARE_BILLING_MODE??'stripe')==='stripe';
}
