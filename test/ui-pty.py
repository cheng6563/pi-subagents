"""Windows ConPTY smoke test using ui.mts fixtures or a recorded multiline run.
An optional second argument selects tool-call-smoke results for read-only replay.
Requires pywinpty and pyte. This test sends no model requests or child tasks.
"""
import json
import os
from pathlib import Path
import select
import re
import shutil
import sys
import time

import pyte
from winpty import PtyProcess

fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
real_run = None
if len(sys.argv) > 2:
    results_path = Path(sys.argv[2])
    real_run = next(item for item in json.loads(results_path.read_text(encoding="utf-8")) if item["name"] == "multiline")
    replay = results_path.parent / "tui-replay"
    replay.mkdir(exist_ok=True)
    parent_copy = replay / "session.jsonl"
    shutil.copyfile(real_run["parentSession"], parent_copy)
    fixture.update(root=str(replay), session=str(parent_copy), localAppData=real_run["localAppData"])
root = Path(fixture["root"])
if real_run is None:
    run_file = Path(fixture["activeRun"])
    run = json.loads(run_file.read_text(encoding="utf-8"))
    run["pid"] = os.getpid()  # Keep the display fixture live; this is not a managed child.
    run_file.write_text(json.dumps(run, ensure_ascii=False), encoding="utf-8")
env = dict(os.environ, PI_CODING_AGENT_DIR=fixture["agentDir"], LOCALAPPDATA=fixture.get("localAppData", fixture["root"]), PI_OFFLINE="1", PI_TELEMETRY="0", TERM="xterm-256color")
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
        if (marker(text) if callable(marker) else marker in text):
            (root / f"pty-{name}.txt").write_text(text, encoding="utf-8")
            print(json.dumps({"stage": name, "status": "passed"}, ensure_ascii=False), flush=True)
            return text
    raise AssertionError(f"Timed out waiting for {name}: {marker}")

try:
    process = PtyProcess.spawn(argv, cwd=fixture["root"], env=env, dimensions=(50, 120))
    (root / "pty-process.json").write_text(json.dumps({"pid": process.pid, "argv": argv}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"stage": "spawn", "pid": process.pid}), flush=True)
    if real_run is not None:
        def numbers(text):
            return {int(line.strip()) for line in text.splitlines() if re.fullmatch(r"\d{3}", line.strip())}
        wait_for(lambda text: "前 97 行" in text and "ctrl+o" in text and {97, 98, 99, 100} <= numbers(text), "real-collapsed-card")
        process.write("\x0f")
        wait_for(lambda text: {96, 100} <= numbers(text) and "前 97 行" not in text, "real-expanded-card")
        process.write("\x0f")
        wait_for(lambda text: "前 97 行" in text and {97, 98, 99, 100} <= numbers(text), "real-recollapsed-card")
        process.write("/subagents-fleet\r")
        first = wait_for(lambda text: "子代理运行详情" in text and 0 in numbers(text), "real-inspector")
        seen = numbers(first)
        for page in range(8):
            if 100 in seen:
                break
            previous = max(seen)
            process.write("\x1b[6~")
            text = wait_for(lambda text: bool(numbers(text)) and max(numbers(text)) > previous, f"real-page-{page}")
            seen.update(numbers(text))
        assert seen == set(range(101)), f"Missing displayed numbers: {set(range(101)) - seen}"
        process.write("\x1b")
        wait_for("前 97 行", "real-close-restores-card")
    else:
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
    (root / "pty-result.json").write_text(json.dumps({"passed": True, "fixtureOnly": real_run is None, "realRunId": real_run["runId"] if real_run else None, "pid": process.pid, "normalExit": not process.isalive()}), encoding="utf-8")
    print(f"PTY_UI_PASS {root.as_posix()}", flush=True)
finally:
    (root / "pty-ansi.log").write_text("".join(raw), encoding="utf-8")
    (root / "pty-final.txt").write_text("\n".join(screen.display), encoding="utf-8")
    if process is not None:
        process.close(force=True)
        print(json.dumps({"stage": "cleanup", "pid": process.pid, "alive": process.isalive()}), flush=True)
