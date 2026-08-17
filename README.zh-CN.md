# dsh Self Checking

![输入框权限选择器中的 Self Checking 选项](legacy/docs/self-checking-permission-picker.png)

中文 | [English](README.md)

本仓库为 [DeepSeek Harness / dsh](https://github.com/deepseek-ai/deepseek-harness)
提供 **Self Checking** 权限模式，并同时维护两条安装路线：

- **Plugin 路线（`plugin/`）** —— 一个普通的 dsh bundle 包
  `dsh-self-checking`，通过 `dsh plugin add` 安装。
- **Legacy profile 路线（`legacy/`）** —— 对上游 `@deepseek-ai` 包的
  可复现 fork 层，以独立 profile 方式安装。

两条路线暴露同一个权限预设：Web 选择器中的 **🛡️🔍 Self Checking**，会话中
用 `/permission self-checking` 切换。模型侧行为一致：命令与文件操作默认在
`workspace-write` 下执行；访问工作区外被拦截一次；重试完全相同的命令/操作
后以完全访问执行。

## 快速安装

### Plugin 路线

```bash
# 在本仓库检出目录中
./install-plugin.sh            # 默认安装到 web profile
# 或显式指定：
./install-plugin.sh -p web -h ~/.dsh
```

```powershell
powershell -ExecutionPolicy Bypass -File install-plugin.ps1
```

启动 dsh 后在权限选择器中选择 **🛡️🔍 Self Checking**。

> 包暂未发布到 npm，因此 `install-plugin.*` 当前安装本地 `plugin/` 目录。
> 发布后的命令将是：`dsh plugin --profile web add dsh-self-checking`。

### Legacy profile/fork 路线

```bash
# 在本仓库检出目录中
./install-legacy.sh                 # profile 名：self-checking
npx @deepseek-ai/dsh --profile self-checking
```

```powershell
powershell -ExecutionPolicy Bypass -File install-legacy.ps1
```

完整的 fork 重建、补丁生成、上游三方合并流程见
[legacy/README.md](legacy/README.md)。

## 两条路线的原理与差异

| | Plugin 路线（`plugin/`） | Legacy profile 路线（`legacy/`） |
|---|---|---|
| 安装单位 | 一个 bundle 包（`dsh-self-checking`），加入现有 profile | 一个完整 profile + 12 个遮蔽 fork 包 |
| 实现原理 | 预设复用 `workspace-write`；插件子类化上游 shell/fs 服务并加入拦截门控 | 在 `SANDBOX_MODES` / `WIDER_MODES` 中新增真正的 `self-checking` 模式，由 fork 执行器和 fs 围栏实现 |
| 上游依赖 | 直接使用上游包（peer dependencies），插件 import 上游服务类 | `upstream/` 字节级固化，`profile/forks/` 保存修改，`patches/*.json` 可逐字节重建 |
| 安装体验 | `dsh plugin --profile web add dsh-self-checking`（当前为本地 `file:`） | `install-legacy.*` 复制 profile 并组装 fork 层 |
| 选择器图标 | 预设名内嵌 `🛡️🔍` emoji | fork 客户端提供专用 SVG 图标 |
| `sandbox_permissions` 枚举 | 仅 `workspace-write` / `danger-full-access`；Self Checking 是预设而非模式 | `workspace-write` / `self-checking` / `danger-full-access` |
| 会话日志 `sandbox/mode` | 预设生效时为 `workspace-write` | `self-checking` |
| 缺失降级行为 | fail closed：退化为普通 `workspace-write + ask` | fail loud：配置加载或执行失败 |
| 上游升级 | 提升 peer 范围并重跑插件测试；适配点为上游服务类内部结构 | `upstream/` 三方合并 → 重生成 patches → 逐字节重建 |

模型可见语义刻意保持一致：拦截/失败 marker、一次性完全重试解锁、fs 防御性
失败提示、`sandbox_permissions + justification` 显式审批通道均相同。

## 仓库结构

```
├── plugin/                      dsh-self-checking bundle 包（新路线）
│   ├── lib/                     Host 插件 + shell/fs 服务子类
│   ├── cordis.patch.yml         禁用原生服务行并添加预设
│   ├── scripts/                 dev-profile 安装器和安装后校验器
│   └── tests/                   单元、Cordis、原生工具层、live runner
├── legacy/                      原 fork/profile 路线
│   ├── profile/forks/           12 个遮蔽 fork 包
│   ├── upstream/                字节级上游基线（0.1.0-rc.6）
│   ├── patches/                 锚定补丁清单 + 审阅 diff
│   ├── tools/                   snapshot / merge / gen-patches / rebuild / release
│   ├── tests/                   legacy 回归 + ACL 探针
│   ├── install.sh / install.ps1
│   ├── verify.mjs
│   └── docs/                    README 引用的截图
├── install-plugin.sh / .ps1     plugin 路线安装器（本地 file 包）
├── install-legacy.sh / .ps1     legacy/install.* 的薄封装
├── docs/self-checking-routes.md 交付路线决策记录
├── CHANGELOG.md
└── LICENSE
```

## 应该选择哪条路线？

- 日常安装与体验：**Plugin 路线**。
- 需要字节级可复现 fork 层、上游基线追踪，或要求会话日志与升权词汇中出现
  真正的 `self-checking` 模式：**Legacy 路线**。

## 环境要求

- dsh **0.1.0-rc.6**（先运行任意 dsh profile 一次，确保
  `~/.dsh/profiles/node_modules` 存在）；
- Windows、macOS 或 Linux。Plugin 路线目前只在 Windows 上有真实 runner
  测试覆盖；Legacy 路线代码与平台无关。

## 开发

```bash
# Plugin 路线
cd plugin
npm test
npm run test:live    # Windows 真实 pwsh + windows-acl runner

# Legacy 路线
node legacy/tests/verify-self-checking.mjs
node legacy/tests/verify-acl-probe.mjs    # Windows 真实 ACL 探针
```

详见 [plugin/README.md](plugin/README.md)、
[legacy/README.md](legacy/README.md) 和
[docs/self-checking-routes.md](docs/self-checking-routes.md)。
