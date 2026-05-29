const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8091;
const GAME_DIR = __dirname;

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
};

const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(GAME_DIR, urlPath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
        });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log('Dev server on port', PORT);
    app.whenReady().then(() => {
        const win = new BrowserWindow({
            width: 1280,
            height: 800,
            title: '天业太空计划 - Dev',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        win.loadURL('http://localhost:' + PORT);
        win.setMenu(null);
        // Cmd+R / Ctrl+R 刷新页面即可看到代码改动
    });
});

app.on('window-all-closed', () => {
    server.close();
    app.quit();
});
