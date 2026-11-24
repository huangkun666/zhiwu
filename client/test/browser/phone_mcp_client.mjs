import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Test input travels over stdin so the temporary device credential stays out of command lines.
const { url, token, tool, args } = JSON.parse(readFileSync(0, 'utf8'));
const client = new Client({ name: 'external-phone-test', version: '1.0.0' });
try {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const response = tool
    ? await client.callTool({ name: tool, arguments: args })
    : { tools: (await client.listTools()).tools.map(item => item.name) };
  process.stdout.write(JSON.stringify(response));
} finally {
  await client.close();
}
