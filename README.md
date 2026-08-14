# 青龙掘金自动签到

用于青龙面板的掘金每日签到脚本，支持多账号、当天免费抽奖和青龙汇总通知。

## 功能

- 多账号依次签到，单个账号失败不会影响其他账号。
- 签到后查询免费抽奖次数，有免费次数才抽奖一次。
- 不执行付费抽奖，不会消耗矿石。
- 重复运行时，“今日已签到”和“无免费抽奖次数”均按正常状态处理。
- 自动尝试调用青龙的 `sendNotify.js`；通知模块不可用时仍会输出控制台结果。
- 日志不会输出完整 Cookie 或其中的 Cookie 字段。
- 通过无头 Chromium 执行网页请求，由掘金安全 SDK 动态生成 `msToken` 和 `a_bogus`。

## 运行要求

- 青龙面板
- Node.js 18 或更高版本
- Chromium
- NodeJS 依赖 `playwright-core`

## 安装浏览器依赖

当前方案需要真实浏览器生成掘金的动态安全签名。优先进入青龙“依赖管理” → “Linux” → “创建依赖”，填写：

```text
chromium
```

也可以在 Alpine 青龙终端立即安装：

```bash
apk add --no-cache chromium
```

然后进入青龙“依赖管理” → “NodeJS” → “创建依赖”，填写：

```text
playwright-core
```

等待两个依赖安装成功后，可在青龙终端检查 Chromium：

```bash
chromium --version
```

脚本默认查找 `/usr/bin/chromium` 和 `/usr/bin/chromium-browser`。如浏览器安装在其他位置，可增加环境变量：

```text
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/实际路径/chromium
```

## 获取 Cookie

1. 在浏览器中登录[稀土掘金](https://juejin.cn/)。
2. 按 `F12` 打开开发者工具，切换到 Network（网络）面板。
3. 刷新网页，选择一个发往 `api.juejin.cn` 的请求。
4. 在 Request Headers（请求标头）中复制完整的 `Cookie` 值，不要复制 `Cookie:` 这个名称。

Cookie 是登录凭证，请勿发到公开仓库、Issue、群聊或任务日志中。登录状态失效后，需要按上述步骤重新获取并更新青龙变量。

## 配置青龙变量

在青龙面板的“环境变量”中新增：

- 名称：`JJ_COOKIE`
- 值：完整的掘金 Cookie

单账号示意：

```text
__tea_cookie_tokens_2608=...; sessionid=...; passport_csrf_token=...
```

多账号支持两种格式。

每行一个账号：

```text
账号1的完整Cookie
账号2的完整Cookie
```

或者使用 `&` 分隔：

```text
账号1的完整Cookie&账号2的完整Cookie
```

建议优先使用换行格式，更容易检查和更新。

## 订阅仓库

在青龙面板的“订阅管理”中新增订阅：

| 配置项 | 值 |
| --- | --- |
| 名称 | `掘金自动签到` |
| 类型 | `公开仓库` |
| 链接 | `https://github.com/moyuuuuuuuuuuu/qlong-juejin-checkin.git` |
| 定时类型 | `crontab` |
| 定时规则 | `0 7 * * *` |
| 白名单 | 留空 |
| 黑名单 | 留空 |

保存后执行一次该订阅。青龙会读取 `juejin_checkin.js` 文件头的任务元数据，自动添加“掘金自动签到”定时任务，不需要再手工新建 `task` 命令。

自动生成的签到任务每天 **10:00** 执行；订阅自身每天 07:00 检查仓库更新。多账号执行时，账号之间会随机等待 1–3 秒。

首次配置 Cookie 后，可以到“定时任务”页面找到“掘金自动签到”，点击运行按钮进行测试。

## 输出示例

```text
账号1
签到成功（奖励 10 矿石，连续 3 天）
免费抽奖：矿石
账号2
今日已签到
无免费抽奖次数
```

## 常见问题

### 提示“未配置 JJ_COOKIE”

确认青龙环境变量名称严格为 `JJ_COOKIE`，变量已启用，并重新执行任务。

### 提示缺少 Chromium 或 playwright-core

按照“安装浏览器依赖”一节安装 Alpine 软件包 `chromium`，并在青龙 NodeJS 依赖管理中安装 `playwright-core`。依赖安装完成后重新执行签到任务。

### 执行订阅后没有自动生成任务

确认订阅类型为“公开仓库”，白名单和黑名单均为空，然后重新执行一次订阅。脚本任务应显示为“掘金自动签到”，定时规则为 `0 10 * * *`。

### 提示签到失败或认证失败

通常是 Cookie 已失效。重新登录掘金并更新完整 Cookie，避免只复制 `sessionid` 的局部值。

如果提示“Cookie 缺少非空 sessionid”或“Cookie 缺少 __tea_cookie_tokens_2608”，说明环境变量内容不是有效的完整 Cookie。如果浏览器签名请求仍被拒绝，应重新登录掘金，从 `api.juejin.cn` 请求的 Request Headers 中复制最新完整 Cookie。

### 签到成功但没有抽奖

脚本只使用当天的免费抽奖次数。如果接口返回的 `free_count` 为 0，脚本会跳过抽奖，绝不会自动消耗矿石。

### 接口突然报错

签到和抽奖使用的是掘金网页当前使用的接口，并非公开稳定 API。若掘金调整接口或强制增加动态签名，日志会保留不含凭证的业务错误信息，便于更新脚本。

## 本地测试

```bash
node --check juejin_checkin.js
node --test test/juejin_checkin.test.js
```

测试使用模拟响应，不会访问掘金，也不需要真实 Cookie。
