"""Windows ConPTY smoke test of the actual Pi TUI, using ui.mts display fixtures.
Requires pywinpty and pyte. No model requests or real child tasks are sent.
"""
import json
import os
from pathlib import Path
import select
import shutil
import sys
import time

import pyte
from winpty import PtyProcess

fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
root = Path(fixture["root"])
run_file = Path(fixture["activeRun"])
run = json.loads(run_file.read_text(encoding="utf-8"))
run["pid"] = os.getpid()  # Keep the display fixture live; this is not a managed child.
run_file.write_text(json.dumps(run, ensure_ascii=False), encoding="utf-8")
env = dict(os.environ, PI_CODING_AGENT_DIR=fixture["agentDir"], LOCALAPPDATA=fixture["root"], PI_OFFLINE="1", PI_TELEMETRY="0", TERM="xterm-256color")
argv = [shutil.which("node"), fixture["cli"], "--offline", "--session", fixture["session"], "--provider", "fixture", "--model", "parent", "--no-extensions", "-e", fixture["extension"], "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--tui-mode", "fullscreen"]
process = None
raw = []
screen = pyte.Screen(120, 50)
stream = pyte.Stream(screen)

def pump():
    if not process.isalive():
        raise AssertionError(f"Pi exited unexpectedly: {process.exitstatus}")
    readable, _, _ = select.select([process.fileobj], [], [], 0.1)
    if readable:
        text = process.read(65536)
        raw.append(text)
        stream.feed(text)
        if "\x1b[6n" in text:
            process.write(f"\x1b[{screen.cursor.y + 1};{screen.cursor.x + 1}R")

def wait_for(marker, name, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pump()
        text = "\n".join(screen.display)
        if marker in text:
            (root / f"pty-{name}.txt").write_text(text, encoding="utf-8")
            print(json.dumps({"stage": name, "status": "passed"}, ensure_ascii=False), flush=True)
            return
    raise AssertionError(f"Timed out waiting for {name}: {marker}")

try:
    process = PtyProcess.spawn(argv, cwd=fixture["root"], env=env, dimensions=(50, 120))
    (root / "pty-process.json").write_text(json.dumps({"pid": process.pid, "argv": argv}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"stage": "spawn", "pid": process.pid}), flush=True)
    wait_for("UI_ACTIVE_CASE", "roster")
    progress_file = Path(fixture["progress"])
    progress = json.loads(progress_file.read_text(encoding="utf-8"))
    progress["activity"] = "PTY_LIVE_UPDATE"
    staging = progress_file.with_suffix(".update")
    staging.write_text(json.dumps(progress, ensure_ascii=False), encoding="utf-8")
    staging.replace(progress_file)
    wait_for("PTY_LIVE_UPDATE", "live-update")
    process.write("/subagents-fleet\r")
    wait_for("子代理运行详情", "inspector")
    process.write("\r\x1b[6~")
    wait_for("UI_TRANSCRIPT_TOOL_RESULT", "transcript")
    process.write("\x1b[B")
    wait_for("深度 2/2", "nested-selection")
    process.write("\x1b")
    wait_for("PTY_LIVE_UPDATE", "close-restores-roster")
    process.write("/quit\r")
    deadline = time.monotonic() + 10
    while process.isalive() and time.monotonic() < deadline:
        readable, _, _ = select.select([process.fileobj], [], [], 0.1)
        if readable:
            try:
                text = process.read(65536)
                raw.append(text)
                stream.feed(text)
            except EOFError:
                break
    (root / "pty-result.json").write_text(json.dumps({"passed": True, "fixtureOnly": True, "pid": process.pid, "normalExit": not process.isalive()}), encoding="utf-8")
    print(f"PTY_UI_PASS {root.as_posix()}", flush=True)
finally:
    (root / "pty-ansi.log").write_text("".join(raw), encoding="utf-8")
    (root / "pty-final.txt").write_text("\n".join(screen.display), encoding="utf-8")
    if process is not None:
        process.close(force=True)
        print(json.dumps({"stage": "cleanup", "pid": process.pid, "alive": process.isalive()}), flush=True)
