'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseCookies,
  parseBrowserCookies,
  extractJuejinUuid,
  buildBrowserUserAgent,
  businessResult,
  redact,
  parseHttpJsonResponse,
  createPageRequester,
  waitForSecuritySdk,
  createBrowserSession,
  getBrowserRuntime,
  runBrowserTask,
  runAccount,
  runAll,
  sendQinglongNotification,
} = require('../juejin_checkin');

function extractQinglongTask(script) {
  const cron = script.match(/^\s*\/\/\s*cron:\s*(.+)$/m)?.[1]?.trim();
  const name = script.match(/^\s*\/\/\s*new Env\(["'](.+)["']\)/m)?.[1];
  return { cron, name };
}

test('QingLong subscription discovers the 10:00 check-in task', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'juejin_checkin.js'), 'utf8');

  assert.deepEqual(extractQinglongTask(script), {
    cron: '0 10 * * *',
    name: '掘金自动签到',
  });
});

test('parseCookies supports newlines and ampersands', () => {
  assert.deepEqual(
    parseCookies('sessionid=a\nsessionid=b&sessionid=c'),
    ['sessionid=a', 'sessionid=b', 'sessionid=c'],
  );
});

test('parseBrowserCookies converts a Cookie header for a Juejin browser context', () => {
  assert.deepEqual(
    parseBrowserCookies('sessionid=test-session; csrf_session_id=test-csrf'),
    [
      {
        name: 'sessionid',
        value: 'test-session',
        domain: '.juejin.cn',
        path: '/',
        secure: true,
      },
      {
        name: 'csrf_session_id',
        value: 'test-csrf',
        domain: '.juejin.cn',
        path: '/',
        secure: true,
      },
    ],
  );
});

test('extractJuejinUuid reads the double-encoded web_id cookie', () => {
  const cookie = '__tea_cookie_tokens_2608=%257B%2522web_id%2522%253A%25221234567890123456789%2522%257D; sessionid=test';

  assert.equal(extractJuejinUuid(cookie), '1234567890123456789');
});

test('buildBrowserUserAgent matches Chromium without advertising headless mode', () => {
  const userAgent = buildBrowserUserAgent('150.0.1234.5', 'linux');

  assert.match(userAgent, /X11; Linux x86_64/);
  assert.match(userAgent, /Chrome\/150\.0\.0\.0/);
  assert.doesNotMatch(userAgent, /Headless/);
});

test('businessResult normalizes a successful Juejin response', () => {
  assert.deepEqual(
    businessResult({ err_no: 0, err_msg: 'success', data: { incr_point: 10 } }),
    {
      ok: true,
      code: 0,
      message: 'success',
      data: { incr_point: 10 },
    },
  );
});

test('redact removes every configured cookie', () => {
  assert.equal(
    redact('request sessionid=secret failed', ['sessionid=secret']),
    'request [REDACTED] failed',
  );
});

test('parseHttpJsonResponse identifies an empty authenticated response', () => {
  assert.throws(
    () => parseHttpJsonResponse(200, ''),
    /接口返回空响应，Cookie 可能已失效或被掘金拒绝/,
  );
});

test('createPageRequester sends the signed base parameters through the page', async () => {
  let pageInput;
  const page = {
    async waitForRequest(predicate) {
      await Promise.resolve();
      assert.equal(predicate({
        url: () => `${pageInput.url}&msToken=other&a_bogus=other`,
        method: () => 'GET',
      }), false);
      assert.equal(predicate({
        url: () => `${pageInput.url.replace('uuid=1234567890123456789', 'uuid=other')}&msToken=other&a_bogus=other`,
        method: () => 'POST',
      }), false);
      const request = {
        url: () => `${pageInput.url}&msToken=test-token&a_bogus=test-signature`,
        method: () => 'POST',
      };
      assert.equal(predicate(request), true);
      return request;
    },
    async evaluate(_callback, input) {
      pageInput = input;
      return {
        status: 200,
        text: '{"err_no":0,"err_msg":"success","data":{"incr_point":100}}',
      };
    },
  };
  const request = createPageRequester(page, '1234567890123456789');

  const response = await request({
    url: 'https://api.juejin.cn/growth_api/v1/check_in',
    method: 'POST',
    body: {},
  });

  assert.equal(
    pageInput.url,
    'https://api.juejin.cn/growth_api/v1/check_in?aid=2608&uuid=1234567890123456789&spider=0',
  );
  assert.equal(pageInput.method, 'POST');
  assert.deepEqual(pageInput.body, {});
  assert.equal(response.err_no, 0);
});

test('createPageRequester reports missing signatures even when the unsigned XHR also fails', async () => {
  let pageInput;
  const page = {
    async waitForRequest(predicate) {
      await Promise.resolve();
      const request = { url: () => pageInput.url, method: () => 'POST' };
      assert.equal(predicate(request), true);
      return request;
    },
    async evaluate(_callback, input) {
      pageInput = input;
      throw new Error('浏览器请求网络错误');
    },
  };

  await assert.rejects(
    createPageRequester(page, '123')({
      url: 'https://api.juejin.cn/growth_api/v1/check_in',
      method: 'POST',
      body: {},
    }),
    /安全签名未生成.*msToken.*a_bogus/,
  );
});

test('waitForSecuritySdk retries only unsigned read-only probes until signing is ready', async () => {
  const calls = [];
  const delays = [];
  const request = async (input) => {
    calls.push(input);
    if (calls.length < 3) {
      throw new Error('掘金安全签名未生成（缺少 msToken 或 a_bogus）');
    }
    return { err_no: 0, err_msg: 'success', data: { free_count: 1 } };
  };

  await waitForSecuritySdk(request, {
    attempts: 4,
    delay: async (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [2000, 2000]);
  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [
    ['https://api.juejin.cn/growth_api/v1/lottery_config/get', 'GET'],
    ['https://api.juejin.cn/growth_api/v1/lottery_config/get', 'GET'],
    ['https://api.juejin.cn/growth_api/v1/lottery_config/get', 'GET'],
  ]);
});

test('createBrowserSession injects cookies and closes its isolated context', async () => {
  const events = [];
  let pageInput;
  const page = {
    async route(pattern) { events.push(['route', pattern]); },
    async goto(url, options) { events.push(['goto', url, options.waitUntil]); },
    async waitForTimeout(milliseconds) { events.push(['wait', milliseconds]); },
    async waitForRequest(predicate) {
      await Promise.resolve();
      const request = {
        url: () => `${pageInput.url}&msToken=test-token&a_bogus=test-signature`,
        method: () => pageInput.method,
      };
      assert.equal(predicate(request), true);
      return request;
    },
    async evaluate(_callback, input) {
      pageInput = input;
      return { status: 200, text: '{"err_no":0,"err_msg":"success","data":{}}' };
    },
  };
  const context = {
    async addCookies(cookies) { events.push(['cookies', cookies]); },
    async newPage() { return page; },
    async close() { events.push(['close']); },
  };
  const browser = {
    async newContext(options) { events.push(['context', options]); return context; },
  };

  const session = await createBrowserSession(
    browser,
    '__tea_cookie_tokens_2608=%257B%2522web_id%2522%253A%25221234567890123456789%2522%257D; sessionid=test',
    { userAgent: 'test-user-agent' },
  );
  await session.close();

  assert.equal(typeof session.request, 'function');
  assert.equal(events[0][0], 'context');
  assert.equal(events[0][1].userAgent, 'test-user-agent');
  assert.equal(events[1][0], 'cookies');
  assert.deepEqual(events.find((event) => event[0] === 'goto').slice(1), [
    'https://juejin.cn/',
    'load',
  ]);
  assert.deepEqual(events.at(-1), ['close']);
});

test('runAccount rejects a cookie without sessionid before making a request', async () => {
  let calls = 0;
  const result = await runAccount('passport_csrf_token=test', 1, async () => {
    calls += 1;
    return {};
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.match(result.lines.join('\n'), /Cookie 缺少非空 sessionid/);
});

test('runAccount signs in and uses one free draw', async () => {
  const calls = [];
  const responses = [
    {
      err_no: 0,
      err_msg: 'success',
      data: { incr_point: 10, sum_point: 100, cont_count: 3 },
    },
    { err_no: 0, err_msg: 'success', data: { free_count: 1 } },
    { err_no: 0, err_msg: 'success', data: { lottery_name: '矿石' } },
  ];

  const result = await runAccount('sessionid=test-a', 1, async (input) => {
    calls.push(input);
    return responses.shift();
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'POST']);
  assert.match(result.lines.join('\n'), /签到成功.*10/);
  assert.match(result.lines.join('\n'), /矿石/);
});

test('runAccount checks free count after an idempotent check-in response', async () => {
  let calls = 0;
  const result = await runAccount('sessionid=test-b', 2, async () => {
    calls += 1;
    return calls === 1
      ? { err_no: 15001, err_msg: '您今日已经签到' }
      : { err_no: 0, err_msg: 'success', data: { free_count: 0 } };
  });

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.match(result.lines.join('\n'), /今日已签到/);
  assert.match(result.lines.join('\n'), /无免费抽奖次数/);
});

test('runAccount redacts individual cookie fields from request errors', async () => {
  const cookie = 'sessionid=top-secret; csrf_token=also-secret';
  const result = await runAccount(cookie, 1, async () => {
    throw new Error('request sessionid=top-secret failed');
  });

  assert.equal(result.ok, false);
  assert.doesNotMatch(result.lines.join('\n'), /top-secret|also-secret/);
});

test('runAccount never draws when free_count is not a finite number', async () => {
  let calls = 0;
  const result = await runAccount('sessionid=test-c', 1, async () => {
    calls += 1;
    return calls === 1
      ? { err_no: 0, err_msg: 'success', data: { incr_point: 5 } }
      : { err_no: 0, err_msg: 'success', data: { free_count: 'unknown' } };
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.match(result.lines.join('\n'), /免费抽奖次数异常/);
});

test('runAll continues after one account fails', async () => {
  const requestedCookies = [];
  const result = await runAll({
    rawCookies: 'sessionid=bad\nsessionid=good',
    delay: async () => {},
    request: async ({ cookie, url }) => {
      requestedCookies.push(cookie);
      if (cookie === 'sessionid=bad') throw new Error('network failed');
      return url.includes('lottery_config')
        ? { err_no: 0, err_msg: 'success', data: { free_count: 0 } }
        : { err_no: 0, err_msg: 'success', data: { incr_point: 5 } };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(requestedCookies, [
    'sessionid=bad',
    'sessionid=good',
    'sessionid=good',
  ]);
  assert.match(result.summary, /账号1/);
  assert.match(result.summary, /账号2/);
});

test('runAll closes each browser session after processing its account', async () => {
  const closed = [];
  const result = await runAll({
    rawCookies: 'sessionid=first\nsessionid=second',
    delay: async () => {},
    sessionFactory: async (cookie) => ({
      request: async ({ url }) => (url.includes('lottery_config')
        ? { err_no: 0, err_msg: 'success', data: { free_count: 0 } }
        : { err_no: 0, err_msg: 'success', data: { incr_point: 5 } }),
      close: async () => { closed.push(cookie); },
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(closed, ['sessionid=first', 'sessionid=second']);
});

test('runBrowserTask always closes Chromium', async () => {
  const events = [];
  const browser = {
    async newContext() { throw new Error('should not create a context without accounts'); },
    async close() { events.push('browser-close'); },
  };
  const chromium = {
    async launch(options) { events.push(['launch', options]); return browser; },
  };

  await assert.rejects(
    runBrowserTask({ rawCookies: '', chromium, executablePath: '/usr/bin/chromium' }),
    /未配置 JJ_COOKIE/,
  );
  assert.equal(events[0][0], 'launch');
  assert.deepEqual(events.at(-1), 'browser-close');
});

test('getBrowserRuntime resolves Alpine Chromium and playwright-core', () => {
  const chromium = { launch() {} };
  const runtime = getBrowserRuntime({
    loadModule: () => ({ chromium }),
    existsSync: (file) => file === '/usr/bin/chromium',
    env: {},
  });

  assert.deepEqual(runtime, {
    chromium,
    executablePath: '/usr/bin/chromium',
  });
});

test('getBrowserRuntime explains how to install missing dependencies', () => {
  assert.throws(
    () => getBrowserRuntime({
      loadModule: () => { throw new Error('module not found'); },
      existsSync: () => false,
      env: {},
    }),
    /playwright-core.*依赖管理/s,
  );
});

test('runAll rejects an empty account configuration', async () => {
  await assert.rejects(
    runAll({ rawCookies: ' \n ', request: async () => ({}) }),
    /未配置 JJ_COOKIE/,
  );
});

test('sendQinglongNotification falls back to the next usable module', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'juejin-notify-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const brokenModule = path.join(directory, 'broken.js');
  const workingModule = path.join(directory, 'working.js');
  fs.writeFileSync(brokenModule, 'module.exports = {};\n');
  fs.writeFileSync(workingModule, 'module.exports.sendNotify = async () => {};\n');

  const sent = await sendQinglongNotification('标题', '内容', {
    candidates: [brokenModule, workingModule],
    logger: { error() {} },
  });

  assert.equal(sent, true);
});
