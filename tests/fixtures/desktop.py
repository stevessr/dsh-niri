"""A disposable application; only this fixture receives integration-test input."""
import json
import os
import sys
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib
root = Path(sys.argv[1])
window = Gtk.Window(title='DSH Niri Fixture')
window.set_wmclass('dsh-niri-fixture', 'dsh-niri-fixture')
window.set_decorated(False)
window.set_default_size(640, 420)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
box.set_border_width(24)
entry = Gtk.Entry()
entry.get_accessible().set_name('Fixture text')
button = Gtk.Button(label='Increment counter')
label = Gtk.Label(label='0')
box.pack_start(entry, False, False, 0)
box.pack_start(button, False, False, 0)
box.pack_start(label, False, False, 0)
window.add(box)
count = 0
pointer_events = []

def publish(*_args):
    point = button.translate_coordinates(window, 0, 0)
    allocation = button.get_allocation()
    data = dict(text=entry.get_text(), count=count, pointer_events=pointer_events,
                button=[point[0] + allocation.width / 2, point[1] + allocation.height / 2] if point else None,
                pid=os.getpid(), env={key: os.environ.get(key) for key in ['NIRI_SOCKET', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']})
    temporary = root / 'state.tmp'
    temporary.write_text(json.dumps(data))
    temporary.replace(root / 'state.json')
    return False

def clicked(_button):
    global count
    count += 1
    label.set_text(str(count))
    publish()

entry.connect('changed', publish)
def pointer_event(_widget, event):
    pointer_events.append(dict(type=str(event.type), x=event.x, y=event.y))
    publish()
    return False

window.add_events(4 | 256 | 512)
window.connect('button-press-event', pointer_event)
window.connect('button-release-event', pointer_event)
window.connect('motion-notify-event', pointer_event)
button.connect('clicked', clicked)
window.connect('size-allocate', publish)
window.connect('destroy', Gtk.main_quit)
window.show_all()
entry.grab_focus()
GLib.idle_add(publish)
Gtk.main()
