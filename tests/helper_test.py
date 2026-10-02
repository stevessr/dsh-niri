"""Deterministic helper tests without a desktop, D-Bus or installed GI bindings."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("desktop", Path(__file__).parents[1] / "helper/desktop.py")
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class Node:
    def __init__(self, name, children=(), actions=(), pid=42):
        self.name, self.children, self.actions, self.pid = name, children, actions, pid
        self.activated = []

    def get_name(self): return self.name
    def get_role_name(self): return "fixture"
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, index): return self.children[index]
    def get_process_id(self): return self.pid
    def get_action_iface(self): return self
    def get_n_actions(self): return len(self.actions)
    def get_action_name(self, index): return self.actions[index]
    def do_action(self, index):
        self.activated.append(index)
        return True


class HelperTests(unittest.TestCase):
    def test_termination_uses_exception_unwinding(self):
        with self.assertRaisesRegex(InterruptedError, "cancelled"):
            desktop.cancel(None, None)

    def test_inverse_coordinates_for_all_eight_output_transforms(self):
        expected = {
            "Normal": (0.2, 0.3), "90": (0.3, 0.8), "180": (0.8, 0.7),
            "270": (0.7, 0.2), "Flipped": (0.8, 0.3), "Flipped90": (0.3, 0.2),
            "Flipped180": (0.2, 0.7), "Flipped270": (0.7, 0.8),
        }
        for transform, point in expected.items():
            with self.subTest(transform=transform):
                self.assertEqual(desktop.untransform(0.2, 0.3, transform), point)
        with self.assertRaises(KeyError): desktop.untransform(0, 0, "unknown")

    def test_releases_button_and_destroys_device_after_failed_drag(self):
        events = []
        class Device:
            def motion_absolute(self, *_args): pass
            def frame(self): pass
            def button(self, _stamp, code, state): events.append((code, state))
            def destroy(self): events.append("destroy")
        objects = {"zwlr_virtual_pointer_manager_v1": (types.SimpleNamespace(create_virtual_pointer_with_output=lambda *_args: Device()), 2), "wl_seat": (object(), 1)}
        with patch.object(desktop, "wayland_session", return_value=(objects, {"output": object()}, lambda: None)):
            with self.assertRaisesRegex(ValueError, "outside"):
                desktop.pointer(dict(output="output", width=100, height=100, transform="Normal", kind="drag", x=10, y=20, toX=500, toY=20))
        self.assertEqual(events, [(272, 1), (272, 0), "destroy"])

    def test_bounded_pid_scoped_tree_and_stale_node_rejection(self):
        button = Node("Click", actions=["click"])
        window = Node("Target", children=[button, Node("More")])
        tree = Node("Desktop", children=[Node("Wrong app", children=[Node("Target")], pid=99), Node("App", children=[window])])
        atspi = types.SimpleNamespace(get_desktop=lambda _index: tree, set_timeout=lambda *_args: None)
        modules = {"gi": types.SimpleNamespace(require_version=lambda *_args: None), "gi.repository": types.SimpleNamespace(Atspi=atspi)}
        request = dict(pid=42, title="Target", timeoutMs=1000, maxTextLength=100, maxNodes=2, maxDepth=12, operation="tree")
        with patch.dict(sys.modules, modules):
            result = desktop.accessibility(request)
            self.assertEqual([node["name"] for node in result["nodes"]], ["Target", "Click"])
            self.assertTrue(result["truncated"])
            node = result["nodes"][1]
            action = dict(request, operation="act", node=node, action="click")
            self.assertEqual(desktop.accessibility(action), {"dispatched": True})
            button.name = "Changed"
            with self.assertRaisesRegex(RuntimeError, "node changed"): desktop.accessibility(action)
            self.assertEqual(button.activated, [0])
            with self.assertRaisesRegex(RuntimeError, "absent or ambiguous"):
                desktop.accessibility(dict(request, pid=100))


if __name__ == "__main__":
    unittest.main()
