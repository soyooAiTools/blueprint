/**
 * SSH tunnel: forward local port 3901 -> ECS 120.55.70.226:3901
 * This lets linux-worker-client.js connect to the blueprint server via localhost:3901
 */
const net = require('net');
const { Client } = require('ssh2');

const LOCAL_PORT = 3901;
const REMOTE_HOST = '127.0.0.1';
const REMOTE_PORT = 3901;
const SSH_HOST = '120.55.70.226';
const SSH_USER = 'root';
const SSH_PASS = 'Soyoo2026!Ecs';

const server = net.createServer((localSocket) => {
  const ssh = new Client();
  ssh.on('ready', () => {
    ssh.forwardOut('127.0.0.1', LOCAL_PORT, REMOTE_HOST, REMOTE_PORT, (err, stream) => {
      if (err) { localSocket.end(); ssh.end(); return; }
      localSocket.pipe(stream).pipe(localSocket);
      stream.on('close', () => { localSocket.end(); ssh.end(); });
      localSocket.on('close', () => { stream.end(); ssh.end(); });
    });
  });
  ssh.on('error', () => localSocket.end());
  ssh.connect({ host: SSH_HOST, port: 22, username: SSH_USER, password: SSH_PASS });
});

server.listen(LOCAL_PORT, '127.0.0.1', () => {
  console.log(`SSH tunnel: localhost:${LOCAL_PORT} → ${SSH_HOST}:${REMOTE_PORT}`);
});
