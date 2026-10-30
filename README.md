# dsh-iab — DSH 内置浏览器插件

给 DSH 装一个**自己的** Chromium：登录一次长期有效，模型能开页面、跑页面 JS、截图，
并把飞书文档直接转成 Markdown。

七个 Agent 工具 + 一个右侧栏实时面板。插件是纯 ESM、无构建步骤、无运行时依赖。

**发布到 npm / 收录进市场**：见 [PUBLISH.md](PUBLISH.md)。

## 为什么需要它

DSH 自带的右侧栏浏览器用的是 `session.fromPartition('dsh-sidebar-browser-<uuid>')`，
**不带 `persist:` 前缀**，所以 Cookie 与 Web Storage 不跨应用重启保留 —— 每次重启都要重登。
`dsh-iab` 把浏览器放在宿主进程自己手里，profile 落在 `$DSH_HOME/dsh-iab/chrome-profile`，
登录态是磁盘上的真实文件。

## 与你自己的浏览器完全隔离（设计硬约束）

这条是硬编码在 `src/browser.js` 里的，不是文档约定：

| 保证 | 实现 |
|---|---|
| 绝不附着到你正在用的 Chrome/Edge | 只通过 `spawn` 启动自己创建的子进程；从不连接已存在的调试端口 |
| 绝不写你的浏览器 profile | 构造 `BrowserHost` 时用 `isForeignProfile()` 校验，命中 `Chrome\User Data`、`Edge\User Data` 等真实 profile 根目录直接抛错 |
| 绝不杀不属于自己的进程 | `stop()` 只对 `this.#child` 操作，且优先走 CDP `Browser.close` 优雅退出 |
| 不弹窗、不抢焦点 | 默认 headless；页面通过插件的 screencast 面板呈现，输入事件反传到页面 |
| 优先用独立构建 | 优先选 Playwright 缓存里的专用 Chromium，系统 Chrome 仅作兜底 |

启动参数刻意不带 `--disable-web-security`、不带任何共享 profile 标志。

## 安装

### 从 npm（发行版）

```sh
dsh plugin --profile web add dsh-iab
```

装完**重启 DSH**：宿主侧部分（7 个工具 + HTTP 路由）在进程启动时组装，只刷新网页不够。
客户端面板走 HMR，所以之后改前端不用重启。

需要一个已初始化的 profile。没装过插件的话先随便跑一次 `dsh web` 让 profile 建好。

### 从本地源码（开发）

```powershell
$dsh = "D:\Users\fan.deng\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add "D:\Users\fan.deng\dsh\testcase-output\dsh-iab"
```

`desktop` profile 必须用安装目录自带的 `dsh.cmd`：通用 CLI 会以 `rejectElectronProfile`
拒绝 desktop profile。装好后 `profiles\desktop\package.json` 的 bundles 末尾会多出 `dsh-iab`。

连的如果是会变动的目录，用链接而不是拷贝：

```powershell
& $dsh plugin --profile desktop add "link:D:\Users\fan.deng\dsh\testcase-output\dsh-iab"
```

安装前的备份（保留，供回滚）：`package.json.bak-beforeinstall`、
`cordis.patch.yml.bak-beforeinstall`、`pnpm-lock.yaml.bak-beforeinstall`。

**回滚（桌面端起不来时）**——先完全退出 DSH，然后：

```powershell
cd D:\Users\fan.deng\dsh\testcase-output\dsh-iab
.\rollback-dsh-iab.ps1 -DryRun   # 先看会改什么
.\rollback-dsh-iab.ps1           # 真回滚
```

脚本只做三件事：还原那三个文件、摘除 `node_modules\dsh-iab` 链接（仅当它是链接）、
校验 `package.json` 里已无残留。**不依赖 DSH 运行**，所以它能救回起不来的情况。

若只想在临时环境里试，用 `test/try-it.ps1`：`start` / `status` / `stop` / `clean`。

## 工具

| 工具 | 作用 |
|---|---|
| `dsh_iab_status` | 报告 Chromium 路径、profile 目录、是否运行、已开标签页 |
| `dsh_iab_open` | 打开 URL，返回 `tabId`；首次调用时启动 Chromium |
| `dsh_iab_eval` | 在页面里执行任意 JS，返回 JSON —— 带登录态，能读私有内容 |
| `dsh_iab_read` | 把页面正文读成纯文本（可用 `scrollPasses` 触发懒加载） |
| `dsh_iab_feishu` | 飞书文档 → Markdown 落盘（虚拟滚动双向回扫） |
| `dsh_iab_screenshot` | 截图存 PNG |
| `dsh_iab_tabs` | 列标签页 / 关标签页 |

## 界面

- **右侧栏标签页**：`sidebar.right.pane.tab` 注册 `dsh-iab` 类型，`keepMounted`，
  用 SSE 接收 `Page.startScreencast` 的 JPEG 帧画到 `<img>`，鼠标/滚轮/键盘经
  `Input.dispatch*` 回传。登录二维码就在这个面板里扫。
- **自动唤出**：工具启动浏览器时，宿主通过 `/dsh-iab/api/events` 广播 `reveal`，
  客户端调 `ctx.sidebarRight.openTab('dsh-iab')` 把面板推到面前。
  **这是能用起来的关键**——否则 agent 打开了登录页，用户根本看不到、没法扫码。
- **设置页**：`settings.section` 显示当前 Chromium 路径、profile 目录、运行状态。

## 自动唤出机制

```
工具 (dsh_iab_open / dsh_iab_feishu)
  → ensure()          启动/接管 Chromium
  → revealBrowser()   events.reveal({reason, url})
        ↓ SSE  /dsh-iab/api/events
客户端 EventSource
  → ctx.sidebarRight.openTab('dsh-iab')   面板出现
  → refresh()                             面板取最新状态
```

三个必须同时成立的细节，缺一个就"唤不出"：

1. **`ctx.inject(['sidebarRight'], scope => …)`** —— `sidebarRight` 必须从注入
   **scope** 里拿。直接读 `ctx.sidebarRight` 是未声明服务访问，Cordis 会抛
   `cannot get property "sidebarRight" without inject`（这个错我踩过）。
2. **tab 类型注册同样走 scope** —— `ctx.inject(['sidebarRightTabs'], scope => …)`，
   否则 `openTab('dsh-iab')` 抛 `no tab type is registered as "dsh-iab"`。
3. **面板自己要订阅 + 轮询** —— `keepMounted` 让面板常驻，不订阅就永远停在
   "浏览器未启动"。现在面板同时挂 `/events` 和 2.5 秒轮询。

`POST /dsh-iab/api/reveal` 可以手动触发同样的广播，方便排查。

## 配置项

都走 schemastery `.volatile()`（否则不会出现在设置页）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `chromePath` | `''` | Chromium 可执行文件；留空自动探测 |
| `profileDir` | `''` | profile 目录，默认 `<dsh home>/dsh-iab/chrome-profile` |
| `headed` | `false` | 是否显示真实窗口；默认关，页面在面板里看 |
| `outDir` | `''` | 落盘目录，默认 `<cwd>/prd-input` |

环境变量 `DSH_IAB_CHROME` 可覆盖浏览器路径。

## 首次登录飞书

1. 让模型调 `dsh_iab_open`，URL 填 `https://<你的租户>.feishu.cn/`。
2. **面板会自动弹出来**（见上面的自动唤出机制），不用自己去右侧栏找。
3. 在面板里扫码/输账号登录。登录态写进 profile 目录。
4. 之后 `dsh_iab_feishu` 直接可用，重启 DSH 也不用重登。

如果面板没自动出现，先看 `/dsh-iab/api/status` 里的 `eventClients`：
0 表示没有客户端订阅，多半是这条 DSH 还在跑旧代码（宿主侧改动需要重启）。
也可以手动 `POST /dsh-iab/api/reveal` 试试。

## 测试

```powershell
cd dsh-iab
node test/apply.mjs            # 宿主侧：真实 dsh-tools 跑 apply()、工具/路由/清理，25 项
node test/client-bundle.mjs    # 客户端：真的求值 bundle 再跑 apply()，25 项
node test/events.mjs           # 事件通道：reveal 广播、容量、断连，14 项
node test/reveal.mjs           # 端到端：工具调用 → reveal 事件 → 面板流，11 项
node test/smoke.mjs            # 真实 Chromium：启动/导航/求值/截图/滚动/回收，25 项
node test/feishu-pipeline.mjs  # 合成飞书页面，验证虚拟滚动采集还原度，14 项
node test/gui-activation.mjs <带 token 的 GUI URL>
                               # 真浏览器：打开 GUI，断言无 "entry did not activate"
node test/reveal-live.mjs <带 token 的 GUI URL> <输出前缀>
                               # 真浏览器 + 真 dsh：点开面板并断言地址栏与画面
```

`test/apply.mjs`、`test/smoke.mjs`、`test/gui-activation.mjs` 需要在
`node_modules/@deepseek-ai/` 下链接宿主的 `dsh-tools`、`schemastery`：

```powershell
cmd /c mklink /J node_modules\@deepseek-ai\dsh-tools  "D:\Users\fan.deng\.dsh\profiles\node_modules\@deepseek-ai\dsh-tools"
cmd /c mklink /J node_modules\@deepseek-ai\schemastery "D:\Users\fan.deng\.dsh\profiles\node_modules\@deepseek-ai\schemastery"
```

## 已知限制

- **画板/图片**只有占位符：`canvas` 与图片位图提取不到文本。
- **评论、@提醒、右侧目录**不采集。
- 飞书登录态存在 profile 里，等价于一份可用的会话凭证 —— profile 目录按凭据对待。
- 面板是 screencast 镜像，不是原生 webview。Chromium 只在画面变化时发帧（空闲时可能
  几秒一帧，滚动/打字时即时），所以静态页看起来像"卡住"，实际是省带宽；阅读与点击不受影响。
- headless 下部分站点会做 UA/指纹探测；需要时把 `headed` 打开即可。
- 同一个 profile 目录只能有一个 Chromium。若并行跑多个 DSH 实例，给其中一份配
  独立的 `profileDir`，否则后启动的那个会报 `Chromium exited before exposing a DevTools port`。

## 实测记录（2026-10-30 · 第二轮，修复 boot 崩溃后）

在**独立临时 profile**（`iabsafe` / `iabverify`，用完已删）上真跑两次 `dsh web`：

| 验证项 | 结果 |
|---|---|
| 无 webServer 的 profile 能否激活 | ✅ 不再 `pending`：`webServer` 改为动态注入，缺失时只跳过面板路由 |
| 有 webServer 的 profile 激活 | ✅ 零警告、stderr 为空 |
| `GET /dsh-iab/api/status` | ✅ 200，返回真实 Chromium 路径与 profile |
| `POST /dsh-iab/api/open` | ✅ 200，`{"tabId":"tab2","title":"Example Domain"}` |
| 客户端 bundle | ✅ 200，14.4 KB，`id: 'dsh-iab'` |
| boot row | ✅ 启动图列出 `dsh-iab` |
| **真浏览器里求值 GUI** | ✅ 无 `did not activate`、无 `dsh-iab: failed`、页面错误与控制台错误均为空 |

### 两次踩的坑（都是 Cordis 的同一类问题）

1. **`inject` 漏声明** → `cannot get property "webServer" without inject`，条目激活失败。
2. **`inject` 声明了 profile 不提供的服务** → 条目永远 `pending`（`waiting for service: webServer`），
   DSH 同样算作 boot 失败。
3. **客户端 `ctx.sidebarRightTabs?.register`** → Cordis 读未声明服务是**抛异常**而不是返回
   `undefined`，`?.` 救不了，整个客户端 `apply` 抛错 → `web boot: 1 entry did not activate`
   → 桌面端直接起不来。这是导致 DSH 无法启动的真凶。

现在的策略：**只硬声明真正必需的 `tools`**，`webServer` / `connection` / `sidebarRightTabs`
全部走 `ctx.inject([...], cb)` 动态注入，并且每个 UI 面各自 try/catch —— 任何 UI 失败都只降级，
不再有能力打死 boot。

### 装回 desktop 前的预检（2026-10-30 第三轮）

因为第一版直接把 desktop 打死过，这次装之前先在**与 desktop 同构的临时 profile**
（`iabpreflight`：`dsh-base` + `dsh-web-app` + `dshmarket` + `skills-management` + `dsh-iab`，
给的是 desktop 的**完全一致的包清单**）上真跑了一次：

| 检查 | 结果 |
|---|---|
| 宿主启动 | ✅ stdout 打印 URL，**stderr 0 字节**（无任何 `did not activate`） |
| `/dsh-iab/api/status` | ✅ 200 |
| 真浏览器求值 GUI | ✅ 7/7，无页面错误、无控制台错误 |
| boot row | ✅ 含 `dsh-iab`（与 `dshmarket`、`skills-management` 共存） |
| 新增崩溃日志 | ✅ 预检期间 0 条 |

预检通过后才写入 `desktop`。安装动作本身只改三个文件：
`package.json`（依赖 + bundles）、`pnpm-lock.yaml`（importer 条目）、`node_modules\dsh-iab` 链接。

### 第四次修复：技能调用时面板不自动出现（2026-10-30）

用户反馈：手工能操作内置浏览器，但工具调用时面板不自己弹出来，看不到登录页。
排查出 **三个独立的 bug**，每一个都足以让"自动唤出"失效：

| # | 症状（浏览器控制台/接口） | 根因 | 修法 |
|---|---|---|---|
| 1 | 完全没有唤出机制 | 工具只操作宿主，从未通知客户端 | 新增 `src/events.js` + `/dsh-iab/api/events`，工具调 `revealBrowser()` |
| 2 | `cannot get property "sidebarRight" without inject` | 事件回调里读 `ctx.sidebarRight`，越出注入 scope | 从 `ctx.inject(['sidebarRight'], scope => …)` 的 scope 取 |
| 3 | `sidebarRight: no tab type is registered as "dsh-iab"` | tab 类型注册也读了 `ctx.sidebarRightTabs`（越界），抛错后整段注册回滚 | 同样改走 scope |

第 3 个特别阴：`withSidebar()` 的 try/catch 把异常吞了，所以**表面上"注册成功"**，
直到 `openTab('dsh-iab')` 才暴露。这也解释了为什么手工点「+」能找到入口、
但程序化唤出却报"类型未注册"——`defaultSeed` 会为已注册类型生成引导胶囊，
而注册其实早已失败。

另外补了两个稳定性问题：

- **面板必须自己订阅**：`keepMounted` 让面板常驻，若不订阅 `/events`，它会永远停在
  "浏览器未启动"。现在面板挂 `/events` + 2.5 秒轮询双保险。
- **面板要跟随宿主的活动标签**：原来固定取 `tabs[0]`，那是 Chromium 自己开的
  `about:blank`，于是工具导航到 `example.com` 后，面板地址栏仍显示 `about:blank`。
  现在 `/status` 返回 `activeTabId`，面板跟随它，用户手工点标签后才"钉住"。

验证（`test/reveal-live.mjs`，真 dsh + 真浏览器）9/9：

| 断言 | 结果 |
|---|---|
| reveal 后右侧栏出现「内置浏览器」 | ✅ |
| 面板 body 挂载 | ✅ |
| 页面确实变化 | ✅ 362 → 401 字符 |
| `/open` 后面板切到实时视图 | ✅ 地址栏出现 |
| 地址栏显示打开的 URL | ✅ `https://example.com/` |
| 面板收到 screencast 帧 | ✅ 33 KB 图像 |

**注意**：宿主侧代码改动需要重启 DSH 才生效；客户端 bundle 走 HMR，刷新页面即可。
