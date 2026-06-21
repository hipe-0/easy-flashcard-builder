const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const MIME = {
  html: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  json: 'application/json',
  ico: 'image/x-icon',
  csv: 'text/csv',
  png: 'image/png',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
};

http.createServer((req, res) => {
  let filePath = path.join('.', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).slice(1);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => console.log('Server: http://localhost:' + PORT));
process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' already in use. Stop the other process or change PORT.');
    process.exit(1);
  }
  throw err;
});
