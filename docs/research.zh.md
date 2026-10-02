# 论文参考与实现取舍

本页区分论文结论和插件自身的设计改编。论文不能证明本实现的可靠性或基准表现。

| 一手来源 | 相关思路 | 本插件的改编 | 未实现部分 |
| --- | --- | --- | --- |
| [UFO²: The Desktop AgentOS](https://arxiv.org/abs/2504.14603) | GUI 感知与应用、系统原生 API 结合 | 使用 niri IPC 操作窗口、AT-SPI 操作控件，以图片和 Wayland 输入补充 | Windows UIA、Host/App 多 Agent 编排、推测执行、学习式记忆、生产级 PiP |
| [AXIS: Turn Every Application into an Agent](https://arxiv.org/abs/2409.17140) | 优先使用可用 API，减少重复的低层 GUI 操作 | 仅公布当前 AT-SPI 动作，执行前再次验证节点 | API 发现和训练流程、自动构造应用 Agent |
| [OSWorld](https://arxiv.org/abs/2404.07972) | 在真实应用中通过最终环境状态评估执行效果 | 临时 GTK 应用独立记录文本和按钮状态，不仅检查命令回执 | OSWorld 任务集、评估分数或同等基准覆盖 |

插件按单个观察令牌执行一次操作，不执行未经逐步验证的动作批次。继续使用 Harness 原有 Agent、策略、工具记录、PTC 与附件机制。独立合成器由部署者选择，插件不会悄悄在用户桌面中创建新会话。

## 平台依据

- [niri IPC](https://niri-wm.github.io/niri/IPC.html) 与 [IPC 类型](https://github.com/niri-wm/niri/blob/main/niri-ipc/src/lib.rs)：稳定窗口和工作区 ID、逻辑几何信息；不得猜测缺失的位置字段。
- [niri 绝对输入映射](https://github.com/niri-wm/niri/blob/main/src/input/mod.rs) 与 [Smithay 变换](https://github.com/Smithay/smithay/blob/master/src/utils/geometry.rs)：绑定输出的虚拟设备需要逆向坐标变换。
- [Python Wayland](https://python-wayland.org/)：复用维护中的生成协议绑定，不自行实现 Wayland 二进制协议。
- [AT-SPI 库](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/)：控件树和动作接口，部分应用不提供这些接口。

实现测试与论文结论独立，见[验证范围及未测情形](testing.md)。
