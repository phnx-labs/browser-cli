const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const dir = path.join(process.env.AGENTS_HOME, '.cache', 'helpers', 'browser');
fs.mkdirSync(dir, { recursive: true });
const socket = path.join(dir, 'browser.sock');
const endpoint = process.platform === 'win32'
  ? '\\\\.\\pipe\\agents-' + require('node:crypto').createHash('sha1').update(socket).digest('hex').slice(0, 16)
  : socket;
const server = net.createServer(client => client.end());
server.listen(endpoint, () => {
  if (!process.argv.includes('no-pid')) fs.writeFileSync(path.join(dir, 'service.pid'), String(process.pid));
  process.stdout.write('ready\n');
});
process.on('SIGTERM', () => {
  if (process.argv.includes('hung')) { fs.appendFileSync(path.join(dir, 'signals'), 'SIGTERM\n'); return; }
  server.close();
  setTimeout(() => {
    fs.writeFileSync(path.join(dir, 'stopped'), 'graceful');
    process.exit(0);
  }, 200);
});
