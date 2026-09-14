/**
 * WD14 Python 标签服务 HTTP 客户端
 * 调用 wd14/wd14_service.py（FastAPI，默认端口 9898）
 */
const http = require('http');

/** 调用 Python 标签服务，返回 { available, rating, general, character } */
function tagImage(imageBase64, host = 'http://127.0.0.1:9898', timeout = 8000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ image: imageBase64 });
    let url;
    try {
      url = new URL('/tag', host);
    } catch {
      resolve({ available: false, error: 'WD14 服务地址无效: ' + host });
      return;
    }
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: '/tag',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.success) {
            resolve({ available: true, rating: data.rating, general: data.general, character: data.character });
          } else {
            resolve({ available: false, error: data.error });
          }
        } catch {
          resolve({ available: false, error: 'WD14 返回解析失败' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ available: false, error: 'WD14 服务超时' }); });
    req.on('error', (e) => { resolve({ available: false, error: e.message }); });
    req.write(payload);
    req.end();
  });
}

/** 健康检查 */
function healthCheck(host = 'http://127.0.0.1:9898', timeout = 3000) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/health', host);
    } catch {
      resolve({ available: false });
      return;
    }
    const req = http.get({
      hostname: url.hostname,
      port: url.port || 80,
      path: '/health',
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ available: true, ...JSON.parse(body) });
        } catch {
          resolve({ available: true });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ available: false }); });
    req.on('error', () => resolve({ available: false }));
  });
}

module.exports = { tagImage, healthCheck };
