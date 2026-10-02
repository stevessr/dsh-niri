"""Private one-request helper: Wayland bindings and bounded AT-SPI access.

The Host owns timeout/termination. No shell, sudo, global input daemon, clipboard
mutation, application launch or arbitrary command execution is exposed here.
"""
import json
import os
import signal
import socket
import struct
import sys
import time


def cancel(_signum, _frame):
    """Unwind pointer cleanup during the Host's graceful termination interval."""
    raise InterruptedError("Desktop command cancelled")


def same_compositor():
    """Refuse input when the IPC and Wayland sockets belong to different processes."""
    display = os.environ["WAYLAND_DISPLAY"]
    display = display if os.path.isabs(display) else os.path.join(os.environ["XDG_RUNTIME_DIR"], display)
    peers = []
    for path in [os.environ["NIRI_SOCKET"], display]:
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(path)
            peers.append(struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)))
    if peers[0] != peers[1]:
        raise RuntimeError("NIRI_SOCKET and WAYLAND_DISPLAY do not belong to the same compositor")


def wayland_session():
    """Bind only the declared input and output protocols in this short-lived process."""
    import wayland
    from wayland.client import wayland_class
    globals_seen, outputs = {}, {}

    @wayland_class("wl_output")
    class Output(wayland.wl_output):
        def on_name(self, name):
            outputs[name] = self

    @wayland_class("wl_registry")
    class Registry(wayland.wl_registry):
        def on_global(self, name, interface, version):
            if interface in ("wl_output", "wl_seat", "zwlr_virtual_pointer_manager_v1", "zwp_virtual_keyboard_manager_v1", "zwlr_screencopy_manager_v1"):
                limit = {"wl_output": 4, "wl_seat": 1, "zwlr_virtual_pointer_manager_v1": 2}.get(interface, 1)
                bound = self.bind(name, interface, min(limit, version)) if interface in ("wl_output", "wl_seat", "zwlr_virtual_pointer_manager_v1") else None
                globals_seen[interface] = (bound, version)

    display = wayland.wl_display()

    def sync():
        done = []
        callback = display.sync()
        callback.events.done += lambda callback_data: done.append(True)
        while not done:
            display.dispatch()

    display.get_registry()
    sync()
    sync()  # wl_output.name arrives after the registry's bind requests.
    return globals_seen, outputs, sync


def untransform(x, y, transform):
    """Undo niri/Smithay's output transform on normalized virtual-device coordinates."""
    return {
        "Normal": (x, y), "90": (y, 1 - x), "180": (1 - x, 1 - y),
        "270": (1 - y, x), "Flipped": (1 - x, y), "Flipped90": (y, x),
        "Flipped180": (x, 1 - y), "Flipped270": (1 - y, 1 - x),
    }[transform]


def pointer(request):
    """Send one output-bound absolute pointer operation and an acknowledged release."""
    objects, outputs, sync = wayland_session()
    manager, version = objects["zwlr_virtual_pointer_manager_v1"]
    if version < 2:
        raise RuntimeError("Output-bound input requires virtual-pointer version 2")
    output = outputs.get(request["output"])
    if output is None:
        raise RuntimeError("Captured output no longer exists on this Wayland display")
    seat = objects["wl_seat"][0]
    device = manager.create_virtual_pointer_with_output(seat, output)
    stamp = lambda: int(time.monotonic() * 1000) & 0xffffffff

    def move(x, y):
        width, height = request["width"], request["height"]
        if not (0 <= x < width and 0 <= y < height):
            raise ValueError("Pointer is outside the output")
        x, y = untransform(x / width, y / height, request["transform"])
        # Normalized uint32 extents retain subpixel positions on large outputs.
        device.motion_absolute(stamp(), round(x * 1_000_000), round(y * 1_000_000), 1_000_000, 1_000_000)
        device.frame()
        sync()

    pressed = None
    try:
        move(request["x"], request["y"])
        kind = request["kind"]
        if kind in ("click", "drag"):
            pressed = {"left": 272, "right": 273, "middle": 274}[request.get("button", "left")]
            device.button(stamp(), pressed, 1)
            device.frame()
            sync()
            if kind == "drag":
                move(request["toX"], request["toY"])
        elif kind == "scroll":
            device.axis_source(0)
            device.axis(stamp(), 0 if request["axis"] == "vertical" else 1, request["amount"])
            device.frame()
            sync()
        elif kind != "move":
            raise ValueError("Unknown pointer action")
    finally:
        if pressed is not None:
            device.button(stamp(), pressed, 0)
            device.frame()
            sync()
        device.destroy()
        sync()
    return {"dispatched": True}


def accessibility(request):
    """Use PID plus an unambiguous top-level title, never another app's global tree."""
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    Atspi.set_timeout(request["timeoutMs"], request["timeoutMs"])
    desktop = Atspi.get_desktop(0)
    candidates = []
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app.get_process_id() != request["pid"]:
            continue
        for j in range(app.get_child_count()):
            window = app.get_child_at_index(j)
            if window.get_name() == request["title"]:
                candidates.append(window)
    if len(candidates) != 1:
        raise RuntimeError("AT-SPI window is absent or ambiguous; use the screenshot tools instead")
    root = candidates[0]

    def describe(node, path):
        action = node.get_action_iface()
        actions = [] if action is None else [action.get_action_name(i) for i in range(action.get_n_actions())]
        return {"path": path, "name": node.get_name()[:request["maxTextLength"]], "role": node.get_role_name(), "actions": actions}

    if request["operation"] == "act":
        node = root
        for index in request["node"]["path"]:
            if not 0 <= index < node.get_child_count():
                raise RuntimeError("Accessibility path is stale")
            node = node.get_child_at_index(index)
        current = describe(node, request["node"]["path"])
        if current != request["node"]:
            raise RuntimeError("Accessibility node changed; inspect again")
        if request["action"] not in current["actions"]:
            raise RuntimeError("The node does not advertise that action")
        accepted = node.get_action_iface().do_action(current["actions"].index(request["action"]))
        if not accepted:
            raise RuntimeError("The application rejected its accessibility action")
        return {"dispatched": True}

    queue, nodes = [(root, [])], []
    truncated = False
    while queue and len(nodes) < request["maxNodes"]:
        node, path = queue.pop(0)
        nodes.append(describe(node, path))
        count = node.get_child_count()
        remaining = request["maxNodes"] - len(nodes) - len(queue)
        if len(path) < request["maxDepth"]:
            for index in range(min(count, max(0, remaining))):
                queue.append((node.get_child_at_index(index), path + [index]))
            truncated |= count > remaining
        else:
            truncated |= count > 0
    return {"nodes": nodes, "truncated": truncated or bool(queue)}


def main(request):
    same_compositor()
    if request["operation"] == "check":
        return {"matched": True}
    if request["operation"] == "probe":
        objects, outputs, _sync = wayland_session()
        if request["accessibility"]:
            import gi
            gi.require_version("Atspi", "2.0")
        return {"protocols": {name: value[1] for name, value in objects.items()}, "outputs": list(outputs), "accessibility": request["accessibility"]}
    if request["operation"] == "pointer":
        return pointer(request)
    if request["operation"] in ("tree", "act"):
        return accessibility(request)
    raise ValueError("Unknown helper operation")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, cancel)
    try:
        print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as error:
        print(f"dsh-niri: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
