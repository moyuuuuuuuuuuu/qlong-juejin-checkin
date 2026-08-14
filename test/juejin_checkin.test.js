'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseCookies,
  businessResult,
  redact,
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
