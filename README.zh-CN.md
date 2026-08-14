# dsh Self Checking profile（自检沙箱配置）

[English](README.md) | 中文

本项目基于 **dsh / DeepSeek Harness** —— DeepSeek 开源的 AI 智能体工作台
（[源码](https://github.com/deepseek-ai/deepseek-harness) ·
[npm 上的 `@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)）：
本项目以 dsh *web profile* 的形式发布，在一份未被修改的 dsh 安装之上叠加一层
可复现的 fork 包集合——上游包保持原样。

一个开箱即用的 dsh web profile，在 `workspace-write` 与 `danger-full-access`
之上新增 **Self Checking（自检）** 沙箱模式，附带完全可复现的 fork 层与发布
工具链。

- **Fork 层** —— `profile/forks/` 下 11 个 fork 的 `@deepseek-ai` 包，仅对本
  profile 遮蔽同名的上游包；上游安装保持原样。
- **补丁集** —— `patches/*.json`（机器可套用的锚定替换）与 `patches/*.diff`
  （供人工审阅），可从一份干净的 dsh 0.1.0-rc.6 安装逐字节重建 fork 层。
- **上游版本追踪** —— `upstream/` 以 git 跟踪的方式固化基线对应的 npm 包
  原始字节，版本记录在 `upstream/VERSION`。升级到新的 dsh 基线是对这份已提交
  快照的**三方合并**（`tools/merge-upstream.mjs`），而非盲目重打补丁：只有上游
  改动的文件直接采纳，只有 fork 改动的文件保持不动，双方都改动的文件用
  `git merge-file`（diff3）合并，真正的冲突会带冲突标记浮出水面而不是静默错
  套。
- **发布工具链** —— 安装脚本、验收校验器、上游升级重建工具与发布打包器。

## Self Checking 做什么

Self Checking 是"带工作区边界检查的完全访问"：

- 每条命令/操作**默认**在 `workspace-write` 限制下运行。
- 因访问**工作区之外**的路径而被拒绝的命令/操作，会被**拦截一次**：模型看到

  ```
  [sandbox: self-check intercepted — this command attempted to access a path
  outside the workspace; unless this access is intentional, do not re-run this
  command — if it IS intentional, re-run the exact same command and it will be
  allowed with full access]
  ```

  并且什么都不会被执行。

  该提示要求模型做出审慎的自我检查：只有当外部访问确属有意时，重试才是被
  认可的唯一延续方式。
- 重试**完全相同的命令/操作**将以**完全访问**权限执行（无审批提示），并在本
  会话剩余时间内持续有效。

它与其他权限预设一样可选——设置 → 权限（新会话默认）或输入框权限选择器 /
`/permission self-checking`（当前会话）。

![输入框权限选择器中的 Self Checking 选项](docs/self-checking-permission-picker.png)

## 仓库结构

```
├── upstream/                  固化的基线快照（git 跟踪）
│   ├── VERSION                基线版本（如 0.1.0-rc.6）
│   └── @deepseek-ai/          11 个包的 npm 原始字节
├── profile/                   可安装的 profile 模板
│   ├── forks/                 11 个 fork 包（唯一事实来源）
│   ├── cordis.patch.yml       Self Checking 权限预设（含布局说明）
│   ├── cordis.yml             profile 根（空条目列表）
│   ├── package.json           打包产物 + fork 的 file: 依赖
│   └── pnpm-workspace.yaml    nodeLinker: hoisted
├── patches/                   重建清单（.json）+ 审阅用 diff（.diff）
├── tools/
│   ├── snapshot-upstream.mjs  将新上游基线固化进 upstream/
│   ├── merge-upstream.mjs     将新基线三方合并进 forks
│   ├── gen-patches.mjs        由干净安装 + forks 重新生成补丁集
│   ├── rebuild-fork.mjs       由干净安装 + 补丁重建 fork 层
│   └── build-release.mjs      打包发布 zip
├── tests/
│   ├── verify-self-checking.mjs   开发回归（词汇/门控/围栏/执行器）
│   ├── verify-acl-probe.mjs       真实 windows-acl 运行器探针
│   └── profile-acl-test.mjs       针对已安装 profile 的完整 ACL 链路
├── install.ps1 / install.sh  将 profile 安装到 $DSH_HOME
├── verify.mjs                验收校验器（复制进每个安装）
├── docs/                     README 引用的截图
├── CHANGELOG.md
└── LICENSE                   MIT（上游包保留各自的 LICENSE）
```

## 环境要求

- dsh **0.1.0-rc.6**（fork 基线；先运行一次 `npx @deepseek-ai/dsh`，让共享回退
  目录 `~/.dsh/profiles/node_modules` 存在）
- Windows、macOS 或 Linux——代码与平台无关；拦截使用各平台的 workspace-write
  后端（Windows 上为 ACL 受限令牌，Linux 上为 bwrap/Landlock，macOS 上为
  Seatbelt）

## 安装

在本仓库的检出目录中：

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File install.ps1          # 安装为 profile "self-checking"
```

```bash
# macOS / Linux
./install.sh
```

脚本把 `profile/` 复制到 `~/.dsh/profiles/<name>/`，并从 `profile/forks/` **组装
fork 层**到 `node_modules/@deepseek-ai/`（node_modules 是构建产物，不受 git
跟踪）。然后启动：

```bash
npx @deepseek-ai/dsh --profile self-checking
```

### pnpm 托管的安装（可选）

profile 同时把 forks 声明为 `package.json` 中的 `file:` 依赖，因此 fork 层可以
由包管理器（重新）安装，而无需复制步骤——重新安装不再修剪它，升级 fork 集合
只需一次依赖版本提升：

```bash
# pnpm 必须在 PATH 中；profile 的 pnpm-workspace.yaml 使用
# nodeLinker: hoisted，forks 会以顶层真实目录落地
dsh plugin --profile self-checking install
```

已验证的布局（pnpm 10、hoisted 链接器、真实 profile 位置）：forks 首先从
`node_modules/@deepseek-ai/...` 解析，fork 内部导入保持在 forks 上，所有未声明
的依赖（`cordis`、`dsh-tools`……）通过常规的父目录回溯解析自共享回退目录。
再次执行 `pnpm install` 会保留 forks（已声明的依赖）。peer 依赖与 koffi
构建脚本警告属预期且无害（原生 koffi 绑定来自 `@koromix/koffi-<platform>`
可选包）。

若想把 forks 以注册表包而非本地目录发布，把每个 `file:` 说明替换为 npm 别名——
`"@deepseek-ai/dsh-sandbox": "npm:<your-scope>/dsh-sandbox-selfchecking@<version>"`
——机制完全相同；但需要先发布那十一个 fork 包。

## 验证

`verify.mjs`（复制进每个安装）沿真实启动路径检查：从 profile 目录解析 fork
（包括客户端 `dsh-client-ui-conversation`，web 插件表经由同一 profile 回溯
解析它）、fork 后的 `SANDBOX_MODES`、扩展的 windows-acl 拒绝方言、预设配置
校验，以及真实文件系统围栏（内部通过 → 外部被拦截 → 重试放行）。

```bash
node ~/.dsh/profiles/self-checking/verify.mjs --profile ~/.dsh/profiles/self-checking
```

## 开发

```bash
# 针对仓库自身 fork 源码的开发回归
node tests/verify-self-checking.mjs
# 可选覆盖：DSH_SC_FORKS=<fork 目录> DSH_SC_UPSTREAM=<干净的 @deepseek-ai 目录>

# 针对真实 windows-acl 运行器的实时 ACL 探针
node tests/verify-acl-probe.mjs
```

### 升级到新的 dsh 基线

固化的快照锁定了基线的 npm 包原始字节；升级是对它的一次可追踪的三方合并，
而不是盲目重打补丁：

```bash
# 1. 准备一份新 dsh 包的 npm 风格解包（例如新版安装的
#    node_modules/@deepseek-ai，或解包的 tarball）——放在仓库外

# 2. 三方合并进 fork 层；成功后固化的快照会被替换，upstream/VERSION 更新
node tools/merge-upstream.mjs 0.1.0-rc.7 <新解包目录>
#    合并规则：只有上游改动的文件直接采纳；只有 fork 改动的文件保持不动；
#    双方都改动的文件用 git merge-file（diff3）合并；真正的冲突会带冲突标记
#    写入 profile/forks 并报告（退出码 1）；上游新增的文件被采纳；上游删除的
#    文件跟随删除（若 fork 改过则保留并警告）

# 3. 解决 profile/forks 中的冲突标记（如有），然后重新生成补丁集并校验
#    逐字节重建：
node tools/gen-patches.mjs
node tools/rebuild-fork.mjs --upstream upstream/@deepseek-ai --out <临时目录> --check profile/forks
node tests/verify-self-checking.mjs

# 4. 一起提交 upstream/ + profile/forks + patches
```

`tools/snapshot-upstream.mjs <版本> <解包目录>` 用于从零固化基线（例如最初
的 0.1.0-rc.6 快照，或重建 `upstream/`）；必须先提交再运行合并，因为合并
从 git HEAD 读取 base。

不升级时重建 fork 层（例如手工编辑 `profile/forks/` 之后，或校验基线）：

```bash
node tools/rebuild-fork.mjs --upstream upstream/@deepseek-ai --out <目录> --check profile/forks
```

若重建结果偏离 `builtAgainst` 基线，`rebuild-fork.mjs` 会以出错锚点响亮失败；
请重新生成补丁清单：

```bash
node tools/gen-patches.mjs <upstream> <fork> <patches-out>
```

### 构建发布包

```bash
node tools/build-release.mjs [version]
# → dsh-profile-self-checking-<version>.zip（profile/ 去掉 node_modules，
#   外加 upstream/、patches、tools、tests、文档、安装脚本）
```

## 说明 / 已知限制

- 拦截门是每会话的内存态：服务器重启即重置（新会话会重新拦截一次）。
- 工作区之外的读取不会被拦截（与 workspace-write 语义一致）；只有被拒绝的
  文件副作用才会。
- 无模型（agentless）调用在自检模式下会探针，但没有重试逃生口——保持拒绝
  （fail closed）。
- 持久终端限制为 workspace-write（终端内没有重试流程）。
- **拦截盲区：进程级限制不会被拦截。** 只有 workspace-write 探针因*文件 ACL
  拒绝*且与后端 stderr 特征匹配而失败时，拦截才会触发。受限令牌的其他限制
  不留此类特征，因此既不会被拦截，也不会被重试解锁：
  - 命名管道（`ssh.exe`/`sh.exe` 报 "couldn't create signal pipe"、捕获子进程
    的管道 stdio），
  - TLS / 凭据存储（schannel `SEC_E_NO_CREDENTIALS`、Git Credential Manager
    提示），
  - 需要特权或 Write-DAC 的操作（例如 `SetNamedSecurityInfo`）。
  当命令以这种方式失败时，模型应首先尝试能在探针下运行的替代方案（不同的
  参数、不同的 TLS 后端、以其他方式提供凭据）；若确实需要完全访问，可以申请
  提权——`sandbox_permissions: "danger-full-access"` + `justification`——Self
  Checking 预设自带 `approval: ask`，因此提权提示会送达用户（若会话的审批策略
  被单独切换为 `never`，请先切回）。作为用户，若看到智能体反复卡在同一个
  非文件错误上，请提示它申请提权执行。
- 对通过复制组装 forks 的 profile，**不要**运行 `dsh plugin --profile <name>
  install`，除非你保持 `forks/` 同步（包管理器会按声明的 `file:` 依赖重建
  node_modules）。

## 卸载

删除 profile 目录（`~/.dsh/profiles/self-checking`）。其他任何东西都不会被
触碰——上游包保持原样。

## 许可证

MIT。每个 fork 包保留其上游 `LICENSE`（Copyright (c) 2026 DeepSeek）；profile
组合、补丁集、工具、测试与文档为 MIT，Copyright (c) 2026 profile 作者。
