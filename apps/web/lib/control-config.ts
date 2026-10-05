// Shared by server routes and the private worker; never imported into a consumer bundle.
export function privateControlConfig(){
  const token=process.env.NEEDWARE_CONTROL_TOKEN;if(!token)return null;
  if(!/^[A-Za-z0-9]{32,128}$/.test(token))throw Error('Invalid private control token');
  const endpoint=new URL(process.env.NEEDWARE_CONTROL_URL??'http://127.0.0.1:3001');
  const loopback=endpoint.hostname==='127.0.0.1'&&endpoint.protocol==='http:';
  if(!loopback&&endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw Error('Private control plane requires loopback HTTP or authenticated HTTPS');
  return {endpoint,headers:{authorization:`Bearer ${token}`}};
}
