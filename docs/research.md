# Research and implementation choices

This page distinguishes published research from this plugin's adaptations. None of the papers establishes this implementation's reliability or benchmark performance.

| Primary source | Relevant idea | Adaptation here | Not implemented |
| --- | --- | --- | --- |
| [UFO²: The Desktop AgentOS](https://arxiv.org/abs/2504.14603) | Combine GUI perception with native application/system APIs | Niri IPC for window operations, AT-SPI for controls, images and Wayland input as complementary interfaces | Windows UIA, Host/App multi-agent orchestration, speculation, learned memory and production PiP |
| [AXIS: Turn Every Application into an Agent](https://arxiv.org/abs/2409.17140) | Prefer available API actions to repeated low-level GUI interaction | Advertise only current AT-SPI actions and revalidate them before invocation | API discovery/training pipeline and autonomous application-agent construction |
| [OSWorld](https://arxiv.org/abs/2404.07972) | Evaluate execution in real applications using resulting environment state | A disposable GTK application records text and button state independently of command acknowledgements | OSWorld task corpus, evaluation score or benchmark equivalence |

The provider executes one operation per observation token rather than an unvalidated action batch. It keeps the existing Harness Agent, policy, tool logging, PTC and attachment machinery. A separate compositor is an operator deployment choice, not something the plugin silently creates on the user's desktop.

## Platform references

- [Niri IPC](https://niri-wm.github.io/niri/IPC.html) and [IPC types](https://github.com/niri-wm/niri/blob/main/niri-ipc/src/lib.rs): stable window/workspace IDs and logical geometry; optional positions must not be inferred.
- [Niri absolute input mapping](https://github.com/niri-wm/niri/blob/main/src/input/mod.rs) and [Smithay transforms](https://github.com/Smithay/smithay/blob/master/src/utils/geometry.rs): output-bound virtual devices need inverse coordinate transformation.
- [Python Wayland](https://python-wayland.org/): maintained generated protocol bindings instead of a handwritten Wayland wire implementation.
- [AT-SPI library](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/): accessibility tree and action interfaces; not all applications expose them.

Tests pin actual behavior separately from research claims; see [verification and untested cases](testing.md).
