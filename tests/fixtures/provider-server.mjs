// Explicit HTTP contract fixture. This is not a model, and never a default provider.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const wire = JSON.parse(readFileSync('artifacts/compiler-fixture.json', 'utf8'));
let requests=0;
const server = createServer(async (request, response) => {
  if(request.method==='GET'&&request.url==='/fixture-count'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({requests}));return;}
  requests++;
  let size = 0; const buffers = [];
  for await (const chunk of request) { size += chunk.length; if (size > 600_000) { response.writeHead(413); response.end(); return; } buffers.push(chunk); }
  const body = JSON.parse(Buffer.concat(buffers).toString());
  await new Promise(resolve => setTimeout(resolve, Number(process.env.NEEDWARE_FIXTURE_DELAY_MS ?? '0')));
  const isIntent = body.messages?.[0]?.content?.startsWith('Extract');
  const output = isIntent ? { goal: 'Track habits', requirements: ['add and complete habits'], unsupported: [] } : wire;
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ temperature: 0.7, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }));
});
server.listen(Number(process.env.NEEDWARE_FIXTURE_PORT ?? '11435'), '127.0.0.1', () => console.log('Authored HTTP contract fixture ready; no model generation'));
