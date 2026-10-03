import 'server-only';
export function controlConfig() {
  const token = process.env.NEEDWARE_CONTROL_TOKEN;
  if (!token) return null;
  const endpoint = new URL(process.env.NEEDWARE_CONTROL_URL ?? 'http://127.0.0.1:3001');
  if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid local control-plane configuration');
  return { endpoint, headers: { authorization: `Bearer ${token}` } };
}
