// Local development server for shubble-map.html (Node 18+, no dependencies).
//
//   node dev-server.mjs
//   open http://localhost:3001/?api=same-origin
//
// The browser loads this page, its CSS/JS, and CDTA JSONs from the same origin.
// Requests to /api/* are still proxied to the Shubble backend.

import http from 'node:http';
import https from 'node:https';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 3001);
const UPSTREAM = new URL(process.env.UPSTREAM ?? 'https://shuttles.rpi.edu');
const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const client = UPSTREAM.protocol === 'https:' ? https : http;

// Only these static files are served. No arbitrary filesystem paths are exposed.
const staticContentTypes = new Map([
    ['/map.html', 'text/html; charset=utf-8'],
    ['/map.css', 'text/css; charset=utf-8'],
    ['/map.js', 'text/javascript; charset=utf-8'],
    ['/cdta-transit.json', 'application/json; charset=utf-8'],
    ['/cdta-departures.json', 'application/json; charset=utf-8']
]);

const server = http.createServer(async (req, res) => {
    const {pathname} = new URL(req.url, 'http://local');

    if (pathname.startsWith('/api/')) {
        const upstreamReq = client.request({
            hostname: UPSTREAM.hostname,
            port: UPSTREAM.port || undefined,
            path: req.url,
            method: req.method,
            headers: {...req.headers, host: UPSTREAM.host}
        }, upstreamRes => {
            res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
            upstreamRes.pipe(res);
        });
        upstreamReq.on('error', err => {
            if (!res.headersSent) {
                res.writeHead(502, {'content-type': 'text/plain; charset=utf-8'});
            }
            res.end(`Could not reach ${UPSTREAM.origin}: ${err.message}`);
        });
        req.pipe(upstreamReq);
        return;
    }

    const filename = pathname === '/' ? '/shubble-map.html' : pathname;
    const contentType = staticContentTypes.get(filename);
    if (contentType) {
        try {
            const bytes = await readFile(path.join(DIRECTORY, filename.slice(1)));
            res.writeHead(200, {'content-type': contentType});
            res.end(bytes);
        } catch (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500, {
                'content-type': 'text/plain; charset=utf-8'
            });
            res.end(`Could not read ${filename}: ${err.message}`);
        }
        return;
    }

    res.writeHead(pathname === '/favicon.ico' ? 204 : 404);
    res.end();
});

server.listen(PORT, () => {
    console.log(`Map:      http://localhost:${PORT}/?api=same-origin`);
    console.log(`Proxying: /api/* -> ${UPSTREAM.origin}`);
});
