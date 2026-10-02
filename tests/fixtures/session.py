"""Boot niri on an allocated Xvfb display, never the user's active desktop."""
import os
from pathlib import Path
import signal
import subprocess
import sys

root = Path(sys.argv[1])
read_fd, write_fd = os.pipe()
children = []

def stop(_signum, _frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    xvfb = subprocess.Popen(['Xvfb', '-displayfd', str(write_fd), '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], pass_fds=[write_fd], stdout=sys.stderr, stderr=sys.stderr)
    children.append(xvfb)
    os.close(write_fd)
    with os.fdopen(read_fd) as stream:
        display = stream.readline().strip()
    if not display:
        raise RuntimeError('Xvfb did not allocate a display')
    config = root / 'config.kdl'
    config.write_text('animations { off; }\nprefer-no-csd\nlayout { gaps 8; default-column-width { proportion 0.7; }; }\n')
    env = os.environ.copy()
    for key in ['WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'NIRI_SOCKET', 'DISPLAY']:
        env.pop(key, None)
    runtime = root / 'runtime'
    runtime.mkdir(mode=0o700)
    env.update(DISPLAY=':' + display, XDG_RUNTIME_DIR=str(runtime), XDG_SESSION_TYPE='x11', LIBGL_ALWAYS_SOFTWARE='1', GDK_BACKEND='wayland', NO_AT_BRIDGE='0', GTK_A11Y='always')
    niri = subprocess.Popen(['niri', '-c', str(config), '--', '/usr/bin/python3', str(Path(__file__).with_name('desktop.py')), str(root)], env=env, stdout=sys.stderr, stderr=sys.stderr)
    children.append(niri)
    # Record owned process identities so teardown tests can verify real exit.
    (root / 'pids.json').write_text(__import__('json').dumps([child.pid for child in children]))
    status = niri.wait()
    if status:
        raise RuntimeError(f'niri exited with {status}')
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
