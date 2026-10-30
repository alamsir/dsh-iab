# 发布 dsh-iab

两条发布路径，互相独立：

| 路径 | 作用 | 是否必需 |
|---|---|---|
| **npm 包** | 用户 `dsh plugin --profile web add dsh-iab` 直接装，免源码构建；市场能显示下载量 | 可选，但强烈推荐 |
| **awesome-dsh-plugin 收录** | 让 dshmarket 和 DSH 0.2.1+ 内置市场能搜到 | 可选 |

不发布 npm 也能被收录（从 GitHub 装），但用户会走源码构建、可能卡在 `allowBuilds` 授权。
本插件零构建步骤、纯 ESM 源码，所以两条路都通。

---

## 0. 发布前必做：改 `repository` 指向真实仓库

`package.json` 里现在写的是占位地址：

```json
"repository": { "type": "git", "url": "git+https://github.com/alamsir/dsh-iab.git" }
```

仓库建好后确认 owner/repo 与实际一致。**npm 包的 `repository` 必须指回被收录的那个仓库**，
否则市场和 npm 包不会被关联（这是刻意的防冒充机制）。

---

## 1. 建仓库并推代码

```powershell
cd D:\Users\fan.deng\dsh\testcase-output\dsh-iab

git init
git add .
git commit -m "dsh-iab 0.1.0: persistent-login in-app browser for DSH"

# 在 GitHub 上先建一个空仓库 alamsir/dsh-iab，然后：
git remote add origin https://github.com/alamsir/dsh-iab.git
git branch -M main
git push -u origin main
```

`.gitignore` 里必须要有的（已在仓库内）：

```
node_modules/
*.tgz
```

**给仓库打 `dsh-plugin` topic** —— 收录检查项之一，在 GitHub 仓库页右上角 About 旁的齿轮里加。

⚠️ 收录要求**仓库创建满 1 天**。刚建好就提 PR 会被 CI 挡下，几小时后再提即可。

---

## 2. 发布到 npm

### 2.1 先登录（当前机器尚未登录）

```powershell
$env:PATH = "D:\Users\fan.deng\software\node-v22.20.0-win-x64;$env:PATH"
npm.cmd whoami          # 现在会报 ENEEDAUTH
npm.cmd login           # 浏览器里授权
npm.cmd whoami          # 应打印用户名
```

> 如果公司网络装不上 `npm login` 的浏览器回跳，改用 token：
> 在 npmjs.com → Access Tokens 生成 Automation token，然后
> `npm.cmd config set //registry.npmjs.org/:_authToken=<token>`。

### 2.2 发布

```powershell
cd D:\Users\fan.deng\dsh\testcase-output\dsh-iab
npm.cmd publish --access public
```

`prepack` 会自动跑 `scripts/preflight.mjs`，任何一项失败就不发包。当前 27 项全通过。

**包名检查过**：`dsh-iab` 在 npm 上未被占用（`npm view dsh-iab` → E404）。

### 2.3 验证发出去的包真的能装

```powershell
$dsh = "D:\Users\fan.deng\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 建一个干净 profile，只装 dsh-base + dsh-web-app + dsh-iab
New-Item -ItemType Directory -Force D:\Users\fan.deng\.dsh\profiles\iabverify | Out-Null
# 写入 package.json（bundles 含 dsh-iab），然后：
& $dsh plugin --profile iabverify add dsh-iab
& $dsh --profile iabverify --no-open --port 64977
```

断言三件事：**stderr 为 0 字节**、`/dsh-iab/api/status` 返回 200、浏览器控制台无
`entry did not activate`。这三条正是发布前踩过的坑，`test/gui-activation.mjs` 已自动化：

```powershell
node test/gui-activation.mjs "http://127.0.0.1:64977/?token=<token>"
```

我这轮已经用**本地 tarball**（`npm pack` 产物）完整走过这条链路，结果：
安装 12.5s → 启动 stderr 0 字节 → GUI 7/7 通过 → `/dsh-iab/api/status` 200。

---

## 3. 提 PR 到 awesome-dsh-plugin

**这个仓库是列表数据源，不是市场应用本身。** 只加**一个文件**，不要手工改 README
（两个 README 由脚本从 `data/plugins/*.yml` 生成）。

### 3.1 文件路径与内容

新建 `data/plugins/alamsir__dsh-iab.yml`：

```yaml
url: https://github.com/alamsir/dsh-iab
name: alamsir/dsh-iab
category: browser
description:
  en: 'In-app browser for DSH: a dedicated persistent-login Chromium driven over CDP, with seven agent tools, page-JavaScript evaluation and a Feishu document reader, mirrored live in a right-sidebar panel.'
  zh: 'DSH 内置浏览器：独立 Chromium + 持久化登录，经 CDP 驱动，提供七个 Agent 工具、页面 JS 求值与飞书文档转 Markdown，并实时镜像到右侧栏面板。'
```

- `category` 取 `browser`（可选值见 contributing.md；选不准维护者会改，不会打回）。
- **`description.en` 含 `: ` 必须加引号**，否则 YAML 把它当嵌套键 —— 上面已加。
- 图标可选：想用方形图标就在仓库放 `assets/icon-180.png`，条目里加
  `icon: https://raw.githubusercontent.com/alamsir/dsh-iab/main/assets/icon-180.png`。
  不写就回退到你的 GitHub 头像。

### 3.2 描述必须属实（会被逐句核对）

我写的这句对应的都是真实实现，评审时可以对上：

| 描述里的说法 | 代码依据 |
|---|---|
| seven agent tools | `src/index.js` 注册 `dsh_iab_status/open/eval/read/feishu/screenshot/tabs` 共 7 个 |
| persistent-login Chromium | `src/browser.js` 的 `defaultProfileDir()` → `<dsh home>/dsh-iab/chrome-profile`，非临时分区 |
| driven over CDP | `src/cdp.js` + `src/tabs.js`，走 `Target.attachToTarget` |
| page-JavaScript evaluation | `dsh_iab_eval` → `Runtime.evaluate` |
| Feishu document reader | `src/feishu.js` + `src/feishu_collect.js`，双向虚拟滚动回扫 |
| right-sidebar panel | `client/client.js` 注册 `sidebar.right.pane.tab` + `ctx.sidebarRight.openTab` 自动唤出 |

**数字写准**：如果你后面加/删了工具，这句必须跟着改。夸大是唯一会让好插件被打回的理由。

### 3.3 提 PR

```powershell
# fork 后
git clone https://github.com/<你>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
# 放入上面那个 yml，然后
npm ci
node scripts/generate-readme.mjs   # 可选，本地预览生成结果
git checkout -b add-dsh-iab
git add data/plugins/alamsir__dsh-iab.yml
git commit -m "add alamsir/dsh-iab"
git push origin add-dsh-iab
```

PR 里只提这一个文件。**一个 PR 最多 3 条**。

### 3.4 CI 会依次检查

1. **条目数** ≤ 3
2. **`dsh.bundle`** —— 从你仓库的 `package.json` 读；只声明 `dsh.client` 会在这里失败
3. **仓库年龄** ≥ 1 天
4. `awesome-lint` + 站点构建

本插件第 2 项已满足（`dsh.bundle.patch` + `cordis.patch.yml` 都在，`preflight` 有断言）。

### 3.5 之后

合并后网站自动重建，通常一天内市场里就能搜到。维护者可能打 `held: author` 标签要求改动 ——
推到同一分支、留**一条**评论说明改了什么即可，不要反复推送。

**截图（可选）**：市场详情页会从 README 抽图。想控制顺序就在仓库根放 `screenshots.json`：

```json
["assets/screenshot-panel.png", "assets/screenshot-feishu.png"]
```

路径相对该文件、不能跳出插件目录；绝对 URL 必须是 GitHub 托管。

---

## 4. 版本升级流程

```powershell
cd D:\Users\fan.deng\dsh\testcase-output\dsh-iab
npm.cmd version patch -m "dsh-iab %s"    # patch / minor / major
git push --follow-tags
npm.cmd publish --access public
```

`npm version` 会自动改 `package.json` 并打 tag。**不要手工改 version 后再 publish**，
那样 tag 和包版本会脱节，市场的更新检测会对不上。

---

## 5. 当前发布状态

| 项 | 状态 |
|---|---|
| `dsh.bundle.patch` + `cordis.patch.yml` | ✅ 已有 |
| `dsh.client.platform = web` | ✅ 已有 |
| `exports` 含 `.` / `./client` / patch | ✅ 已补齐 |
| `repository` / `homepage` / `bugs` | ⚠️ 占位为 `alamsir/dsh-iab`，需与真实仓库一致 |
| `license` | ✅ MIT，`LICENSE` 已加 |
| `files[]` | ✅ `src` / `client` / patch / LICENSE，不含 test 与 node_modules |
| `prepack` 预检 | ✅ 27 项全通过 |
| 官方包全部走 peerDependencies | ✅ 无 `@deepseek-ai/*` 运行时依赖 |
| peer 范围覆盖当前宿主 | ✅ cordis `^4.0.4`（装的是 4.0.4）、dsh-tools `>=0.1.7-rc.2`、schemastery `>=3.18.4` |
| `engines.dsh` 含预发布分支 | ✅ 匹配 0.2.1-rc.5，排除 0.3.x |
| npm 包名可用 | ✅ `dsh-iab` 未被占用 |
| npm 登录 | ❌ 本机未登录，需先 `npm login` |
| Git 仓库 | ❌ 尚未 `git init` |
| `dsh-plugin` topic | ❌ 建仓后要加 |
| 仓库满 1 天 | ⏳ 建仓后等一天再提 PR |

### 已改动的文件

- `package.json` —— 去 `private`，补 license/author/repository/homepage/bugs/exports/files/publishConfig/scripts，修 cordis peer 范围（`~4.0.5` **不满足**宿主实装的 4.0.4，已实测）；`engines.dsh` 改成带预发布分支的范围。
- `scripts/preflight.mjs` —— 新增，`prepack` 钩子，27 项检查。
- `LICENSE` —— 新增，MIT。

### 已知的版本范围局限

`engines.dsh` 写成 `>=0.2.0-0 <0.3.0-0 || >=0.2.1-rc.1 <0.3.0-0`。
node-semver 的规则是：预发布版本只有在范围里有**同 major.minor.patch 元组且带预发布标签**
的比较符时才放行。所以未来的 `0.2.2-rc.1` 会被这条范围排除 —— 到那时把 `<0.2.2` 的
预发布分支补上再发版即可。稳定版 `0.2.x` 全在范围内。
