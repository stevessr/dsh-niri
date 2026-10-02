# dsh-niri

[English](README.md) | 中文

让 [DeepSeek Harness](https://github.com/stevessr/deepseek-harness) 操作本地 [niri](https://github.com/niri-wm/niri) 桌面：优先使用合成器 IPC 和应用无障碍接口，像素输入作为补充。这是独立的 Cordis 插件，不另建 agent loop，也不是 MCP 包装器。

- 查询窗口、稳定的工作区 ID 和输出几何信息；通过 niri IPC 聚焦、移动窗口、切换浮动或平铺。
- 读取有数量限制的 AT-SPI 控件树，按 PID 与标题匹配窗口，只调用控件声明的动作。
- 使用 `grim` 保存持久截图、`wtype` 输入 Unicode，通过绑定输出的 Wayland 虚拟指针移动、点击、拖动及滚动。
- **默认只读**；跨 Agent 串行执行；拒绝过期、失效、已消费或属于其他 Agent 的观察令牌；卸载时取消并等待子进程退出，再释放 computer-use 占用。

设计参考 [UFO²、AXIS 和 OSWorld](docs/research.zh.md)，不宣称完整复现论文系统或达到其基准成绩。

## 环境与构建

需要 Linux、Node `^22.19.0 || >=24`、Harness `0.2.0-rc.2`、Cordis `4.0.4` 和本地 niri 会话。实测版本为 niri `26.04 (v26.04-160-g1f03391e)`。其他版本须提供相同 IPC 字段以及 virtual-pointer v2、virtual-keyboard v1、screencopy 协议；缺少协议会启动失败。不支持其他 Wayland 合成器。

通过发行版安装 `niri`、`grim`、`wtype`、Python 3、Python GI 和 AT-SPI 2 typelib。可选的无障碍后端还要求应用导出 AT-SPI，并使用匹配的会话 D-Bus。插件不会自动安装程序、启动合成器、申请 root 或使用全局输入守护进程。

```sh
pnpm install --frozen-lockfile
python3 -m venv --system-site-packages .venv
.venv/bin/pip install -r helper/requirements.txt
pnpm build
pnpm pack
```

Python 依赖是 **`python-wayland==1.0.0`**，不是 PyPI 上另一个名为 `wayland` 的包。GI 使用系统 Python 安装提供的绑定。本仓库尚未发布 npm 包；将生成的 `stevessr-dsh-niri-0.1.0.tgz` 安装到 Harness profile 的包解析目录。

## 配置

在提供 `tools`、`systemPrompt` 和附件存储的具名 `dsh` profile 中挂载以下条目。已有 `computerUse` 服务时不要重复添加，也不要同时启用另一个 computer-use 提供者。应用仍通过 `dsh` profile 启动；本包没有独立可执行入口。

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- id: niri
  name: '@stevessr/dsh-niri'
  config:
    pythonCommand: /absolute/path/to/dsh-niri/.venv/bin/python
    mode: tools
    readOnly: true
    accessibility: true
```

请从目标 niri 会话启动，或显式配置 `socketPath`、`waylandDisplay`、`runtimeDir`、`dbusAddress`。IPC 与 Wayland socket 必须属于同一合成器进程。Settings 可实时修改 `readOnly` 和 `mode`；其他字段修改后需重载条目。完整字段见[配置参考](docs/configuration.md)。

原版 Harness 支持 `mode: tools`。可选的 `mode: typescript` 只通过 `run_code` 中的函数暴露这六个工具，需要[固定版本 Host 补丁](integration/README.md)及 Node PTC runtime；不支持的 Host 会明确报错，不会偷偷退回原生工具。其他工具的呈现模式不受影响。

## 模型操作流程

1. `niri_observe` 获取窗口和 app ID。窗口标题及应用内容均视为不可信数据。
2. 优先使用 `niri_accessibility`，再将已公布的节点路径和动作传给 `niri_activate`。
3. 需要像素或键盘操作时，先在可信 Settings 中允许输入，用 `niri_window` 聚焦，再调用 `niri_capture`，将其 `snapshotId` 传给 `niri_input`。
4. 操作后重新观察应用。`dispatched: true` 仅确认发送动作，**不代表用户任务完成**；输入失败后不要盲目重试。

`niri_capture` 默认 `area: window`；窗口缺少坐标或部分位于屏幕外时会拒绝。niri 当前不提供平铺窗口的位置；可以明确选择 `area: output` 截取所在输出的整个画面，或使用语义动作。不会悄悄扩大截图范围。`float` 动作会明确改变布局，截图本身不会。坐标基于 Harness 归一化并保存后的图片，而非显示器原始物理像素。

每次输入都会消费全部旧令牌，包括部分执行后失败的情况。截图令牌和无障碍令牌不可混用，重载后不可复用。原生结果采用 Host 通用 JSON 卡片及持久图片渲染；原生与 PTC 调用均走正常工具和会话记录流程，规范工具值不包含 base64 图片。验证范围见[测试说明](docs/testing.md)。

## 限制与信任

无人值守操作请使用**独立合成器或会话**。焦点、元数据检查与输入不是原子事务，无法识别所有动画、覆盖层、弹窗或同标题下的内容变化。`area: output` 包含其他应用，并允许点击该输出上的其他位置；窗口裁剪也可能包含覆盖层。`allowedAppIds` 仅过滤选中的窗口，不过滤截图像素或任意应用快捷键产生的效果，不是沙箱或秘密过滤器。

AT-SPI 要求 PID 与标题共同唯一匹配一个窗口。浏览器、Electron 和 XWayland 应用可能没有可用控件树。辅助程序读取名称、角色和动作，不调用 Text/Value 接口，但无障碍名称及截图仍可能包含敏感内容。重复标题、节点变化或缺少无障碍支持会导致失败，不会改为操作其他窗口。

队列只协调当前提供者实例，无法协调人工操作及其他 Harness 进程。取消不能撤回已发送动作。指针操作在异常和正常终止信号下会尝试释放按钮，但强制终止或合成器断连可能阻止释放。临时截图会被删除，持久附件遵循 Host 保留策略。卸载会移除工具并等待工作结束，但不关闭应用或停止用户的合成器。插件未导出自定义 `./invariant`：它管理临时注册和观察令牌，不维护可独立观察的持久索引。

## 许可

MIT，见 [LICENSE](LICENSE)。可选 Host 补丁与 [dsh-cua-driver](https://github.com/stevessr/dsh-cua-driver) 共用；外部程序保留各自许可。
