// cron: 0 10 * * *
// new Env("掘金自动签到")

'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const ENDPOINTS = Object.freeze({
  checkIn: 'https://api.juejin.cn/growth_api/v1/check_in',
  lotteryConfig: 'https://api.juejin.cn/growth_api/v1/lottery_config/get',
  lotteryDraw: 'https://api.juejin.cn/growth_api/v1/lottery/draw',
});

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/126.0.0.0 Safari/537.36';

function parseCookies(raw = '') {
  return String(raw)
    .split(/\r?\n|&/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCookiePairs(cookie) {
  return String(cookie)
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf('=');
      if (separator <= 0) return null;
      return {
        name: item.slice(0, separator).trim(),
        value: item.slice(separator + 1).trim(),
      };
    })
    .filter((item) => item?.name);
}

function parseBrowserCookies(cookie) {
  return parseCookiePairs(cookie).map(({ name, value }) => ({
    name,
    value,
    domain: '.juejin.cn',
    path: '/',
    secure: true,
  }));
}

function extractJuejinUuid(cookie) {
  const token = parseCookiePairs(cookie)
    .find(({ name }) => name === '__tea_cookie_tokens_2608')?.value;
  if (!token) throw new Error('Cookie 缺少 __tea_cookie_tokens_2608，无法提取浏览器 UUID');
  try {
    const data = JSON.parse(decodeURIComponent(decodeURIComponent(token)));
    const uuid = data.web_id ?? data.user_unique_id;
    if (!uuid) throw new Error('missing web_id');
    return String(uuid);
  } catch {
    throw new Error('Cookie 中的浏览器 UUID 格式无效，请重新复制完整 Cookie');
  }
}

function businessResult(response = {}) {
  const code = response.err_no ?? response.err_code ?? -1;
  return {
    ok: Number(code) === 0,
    code,
    message: String(response.err_msg ?? response.message ?? '未知响应'),
    data: response.data,
  };
}

function redact(text, cookies = []) {
  const secrets = cookies
    .flatMap((cookie) => [cookie, ...cookie.split(';').map((item) => item.trim())])
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  return secrets.reduce(
    (output, secret) => output.split(secret).join('[REDACTED]'),
    String(text),
  );
}

function parseHttpJsonResponse(statusCode, text) {
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`HTTP ${statusCode}`);
  }
  if (!text.trim()) {
    throw new Error('接口返回空响应，Cookie 可能已失效或被掘金拒绝');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('接口返回了无效 JSON，可能触发了掘金风控');
  }
}

function createPageRequester(page, uuid) {
  return async ({ url, method = 'GET', body }) => {
    const apiUrl = new URL(url);
    apiUrl.searchParams.set('aid', '2608');
    apiUrl.searchParams.set('uuid', uuid);
    apiUrl.searchParams.set('spider', '0');

    const response = await page.evaluate(
      ({ url: requestUrl, method: requestMethod, body: requestBody }) => new Promise(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open(requestMethod, requestUrl, true);
          xhr.withCredentials = true;
          xhr.timeout = 15000;
          xhr.setRequestHeader('content-type', 'application/json');
          xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
          xhr.onerror = () => reject(new Error('浏览器请求网络错误'));
          xhr.ontimeout = () => reject(new Error('浏览器请求超时（15000ms）'));
          xhr.send(requestBody === undefined ? null : JSON.stringify(requestBody));
        },
      ),
      { url: apiUrl.toString(), method, body },
    );

    return parseHttpJsonResponse(response.status, response.text);
  };
}

async function createBrowserSession(browser, cookie) {
  const context = await browser.newContext();
  try {
    await context.addCookies(parseBrowserCookies(cookie));
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['image', 'media', 'font'].includes(resourceType)) return route.abort();
      return route.continue();
    });
    await page.goto('https://juejin.cn/user/center/signin?from=main_page', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
    return {
      request: createPageRequester(page, extractJuejinUuid(cookie)),
      close: () => context.close(),
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function createHttpRequester({ timeoutMs = 15000 } = {}) {
  return ({ url, method = 'GET', cookie, body }) => new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers = {
      Cookie: cookie,
      'User-Agent': DEFAULT_USER_AGENT,
      Origin: 'https://juejin.cn',
      Referer: 'https://juejin.cn/',
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const request = https.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(parseHttpJsonResponse(response.statusCode, text));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function isAlreadyCheckedIn(result) {
  return /已经签到|已签到/.test(result.message);
}

function checkInLine(data = {}) {
  const details = [];
  const points = data.incr_point ?? data.incrPoint;
  const continuousDays = data.cont_count ?? data.contCount;
  if (points !== undefined) details.push(`奖励 ${points} 矿石`);
  if (continuousDays !== undefined) details.push(`连续 ${continuousDays} 天`);
  return `签到成功${details.length ? `（${details.join('，')}）` : ''}`;
}

async function runAccount(cookie, accountIndex, request) {
  const lines = [`账号${accountIndex}`];
  if (!/(?:^|;\s*)sessionid=[^;\s]+/.test(cookie)) {
    lines.push('Cookie 缺少非空 sessionid，请从已登录的掘金请求中重新复制完整 Cookie');
    return { ok: false, lines };
  }
  try {
    const checkIn = businessResult(await request({
      url: ENDPOINTS.checkIn,
      method: 'POST',
      cookie,
      body: {},
    }));
    if (checkIn.ok) {
      lines.push(checkInLine(checkIn.data));
    } else if (isAlreadyCheckedIn(checkIn)) {
      lines.push('今日已签到');
    } else {
      lines.push(`签到失败：${redact(checkIn.message, [cookie])}`);
      return { ok: false, lines };
    }

    const lotteryConfig = businessResult(await request({
      url: ENDPOINTS.lotteryConfig,
      method: 'GET',
      cookie,
    }));
    if (!lotteryConfig.ok) {
      lines.push(`查询免费抽奖次数失败：${redact(lotteryConfig.message, [cookie])}`);
      return { ok: false, lines };
    }

    const rawFreeCount = lotteryConfig.data?.free_count;
    const freeCount = Number(rawFreeCount);
    if (!Number.isFinite(freeCount) || freeCount < 0) {
      lines.push('免费抽奖次数异常，为避免消耗矿石已停止抽奖');
      return { ok: false, lines };
    }
    if (freeCount <= 0) {
      lines.push('无免费抽奖次数');
      return { ok: true, lines };
    }

    const draw = businessResult(await request({
      url: ENDPOINTS.lotteryDraw,
      method: 'POST',
      cookie,
      body: {},
    }));
    if (!draw.ok) {
      lines.push(`免费抽奖失败：${redact(draw.message, [cookie])}`);
      return { ok: false, lines };
    }

    const prizeName = draw.data?.lottery_name ?? draw.data?.lotteryName ?? '未知奖品';
    lines.push(`免费抽奖：${prizeName}`);
    return { ok: true, lines };
  } catch (error) {
    lines.push(`执行失败：${redact(error?.message ?? error, [cookie])}`);
    return { ok: false, lines };
  }
}

function defaultDelay() {
  const milliseconds = 1000 + Math.floor(Math.random() * 2001);
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runAll({ rawCookies, request, delay = defaultDelay }) {
  const cookies = parseCookies(rawCookies);
  if (cookies.length === 0) throw new Error('未配置 JJ_COOKIE');

  const results = [];
  for (let index = 0; index < cookies.length; index += 1) {
    if (index > 0) await delay();
    results.push(await runAccount(cookies[index], index + 1, request));
  }

  return {
    ok: results.every((result) => result.ok),
    summary: results.flatMap((result) => result.lines).join('\n'),
  };
}

function notificationCandidates() {
  return [
    path.resolve(process.cwd(), 'sendNotify.js'),
    path.resolve(process.cwd(), '..', 'sendNotify.js'),
    '/ql/data/scripts/sendNotify.js',
    '/ql/scripts/sendNotify.js',
  ];
}

async function sendQinglongNotification(
  title,
  content,
  { candidates = notificationCandidates(), logger = console } = {},
) {
  let lastError;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const notificationModule = require(candidate);
      const sendNotify = typeof notificationModule === 'function'
        ? notificationModule
        : notificationModule.sendNotify;
      if (typeof sendNotify !== 'function') {
        lastError = new Error(`${candidate} 未导出 sendNotify 函数`);
        continue;
      }
      await sendNotify(title, content);
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) logger.error(`发送青龙通知失败：${lastError?.message ?? lastError}`);
  return false;
}

async function main() {
  try {
    const result = await runAll({
      rawCookies: process.env.JJ_COOKIE,
      request: createHttpRequester(),
    });
    console.log(result.summary);
    await sendQinglongNotification('掘金签到', result.summary);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ENDPOINTS,
  parseCookies,
  parseBrowserCookies,
  extractJuejinUuid,
  businessResult,
  redact,
  parseHttpJsonResponse,
  createPageRequester,
  createBrowserSession,
  createHttpRequester,
  runAccount,
  runAll,
  sendQinglongNotification,
};
