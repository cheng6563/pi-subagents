"""Actual Pi live-dock checks in regular and fullscreen renderers, using display fixtures.
No model calls. Regular mode checks the emitted scrollback-clear protocol; fullscreen
also sends real wheel input and checks the selected history position across refreshes.
"""
import datetime
import json
import os
from pathlib import Path
import re
import select
import shutil
import sys
import time

import pyte
from winpty import PtyProcess

fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
root = Path(fixture["root"])

def save(path, value):
    path = Path(path)
    temporary = path.with_suffix(".fixture-update")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)

def history(text):
    return tuple(int(n) for n in re.findall(r"HISTORY_(\d{3})", text))

summaries = []
for mode in ("regular", "fullscreen"):
    evidence = root / f"live-{mode}"
    evidence.mkdir(exist_ok=True)
    parent_session = evidence / "session.jsonl"
    shutil.copyfile(fixture["session"], parent_session)
    run = json.loads(Path(fixture["activeRun"]).read_text(encoding="utf-8"))
    run.update(status="running", pid=os.getpid())
    save(fixture["activeRun"], run)
    save(fixture["progress"], {"activity": "LIVE_INITIAL", "text": "initial", "tools": 0, "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    env = dict(os.environ, PI_CODING_AGENT_DIR=fixture["agentDir"], LOCALAPPDATA=fixture["root"], PI_OFFLINE="1", PI_TELEMETRY="0", PI_TUI_DEBUG_REDRAW="1", TERM="xterm-256color")
    argv = [shutil.which("node"), fixture["cli"], "--offline", "--session", str(parent_session), "--provider", "fixture", "--model", "parent", "--no-extensions", "-e", fixture["extension"], "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--tui-mode", mode]
    process = None
    screen = pyte.Screen(120, 50)
    stream = pyte.Stream(screen)
    raw = []
    synchronized_frame = {"active": False, "tail": ""}

    def pump():
        if not process.isalive():
            raise AssertionError(f"Pi exited: {process.exitstatus}")
        readable, _, _ = select.select([process.fileobj], [], [], 0.1)
        if readable:
            text = process.read(65536)
            raw.append(text)
            stream.feed(text)
            protocol = synchronized_frame["tail"] + text
            for token in re.finditer(r"\x1b\[\?2026([hl])", protocol):
                synchronized_frame["active"] = token.group(1) == "h"
            synchronized_frame["tail"] = protocol[-32:]
            if "\x1b[6n" in text:
                process.write(f"\x1b[{screen.cursor.y + 1};{screen.cursor.x + 1}R")

    def wait_for(predicate, name, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump()
            text = "\n".join(screen.display)
            if not synchronized_frame["active"] and predicate(text):
                (evidence / f"{name}.txt").write_text(text, encoding="utf-8")
                return text
        raise AssertionError(f"Timed out at {mode}/{name}")

    try:
        process = PtyProcess.spawn(argv, cwd=fixture["root"], env=env, dimensions=(50, 120))
        (evidence / "process.json").write_text(json.dumps({"pid": process.pid, "argv": argv}), encoding="utf-8")
        print(json.dumps({"mode": mode, "stage": "spawn", "pid": process.pid}), flush=True)
        wait_for(lambda text: "LIVE_INITIAL" in text and "HISTORY_199" in text, "initial")
        # Pi initializes syntax highlighting after its first paint. Require a stable
        # interval longer than the old clock tick; repeated subagents clears cannot pass.
        deadline = time.monotonic() + 8
        stable_since = time.monotonic()
        observed = len(raw)
        while time.monotonic() - stable_since < 1.25 or synchronized_frame["active"]:
            assert time.monotonic() < deadline, "Startup never stopped clearing scrollback"
            pump()
            if "\x1b[3J" in "".join(raw[observed:]):
                stable_since = time.monotonic()
            observed = len(raw)
        initial = "\n".join(screen.display)
        (evidence / "stable-initial.txt").write_text(initial, encoding="utf-8")
        panel_row = next(i for i, line in enumerate(initial.splitlines()) if "subagents ·" in line)
        assert panel_row >= 35, "Live information must stay in the bottom dock"
        anchor = None
        if mode == "fullscreen":
            old_first = history(initial)[0]
            process.write("\x1b[<64;15;10M" * 5)
            scrolled = wait_for(lambda text: bool(history(text)) and 0 < history(text)[0] < old_first, "wheel-middle")
            anchor = history(scrolled)
        offset = len(raw)
        bodies = ["", "short", "W" * 6000, "\n".join(f"LINE_{i} " + "中文🙂\t" * 150 for i in range(12)), "\x1b[31m" + "colored " * 600 + "\x1b[0m", "last\nfour\nlogical\nlines"]
        for index, body in enumerate(bodies):
            marker = f"LIVE_UPDATE_{index}"
            progress = {"activity": marker, "text": body, "tools": index, "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
            if index % 2:
                progress.update(currentTool="bash", toolOutput=body)
            save(fixture["progress"], progress)
            current = wait_for(lambda text: marker in text, f"update-{index}")
            assert next(i for i, line in enumerate(current.splitlines()) if "subagents ·" in line) == panel_row, "Content changes must not change dock height"
            if anchor is not None:
                assert history(current) == anchor, "Refreshing the dock must not move the selected history"
        assert "\x1b[3J" not in "".join(raw[offset:]), "Active progress must not clear native scrollback"
        Path(fixture["output"]).write_text("FINAL_LIVE_RESULT", encoding="utf-8")
        save(fixture["progress"], {"activity": "completed", "text": "FINAL_LIVE_RESULT", "tools": 6, "tokens": 99, "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        run.update(status="completed", updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        save(fixture["activeRun"], run)
        ended = wait_for(lambda text: "subagents ·" not in text and bool(history(text)), "completed")
        if mode == "fullscreen":
            old_first = history(ended)[0]
            process.write("\x1b[<64;15;10M")
            ended = wait_for(lambda text: bool(history(text)) and 0 < history(text)[0] < old_first, "completed-wheel-middle")
        ended_anchor = history(ended)
        offset = len(raw)
        # Negative stability observation, not a readiness sleep: span several old 250 ms polling ticks.
        deadline = time.monotonic() + 1.4
        while time.monotonic() < deadline:
            pump()
            if not synchronized_frame["active"]:
                assert history("\n".join(screen.display)) == ended_anchor, "Idle refresh must not move history after completion"
        assert "\x1b[3J" not in "".join(raw[offset:]), "Completed subagents must not clear scrollback repeatedly"
        summaries.append({"mode": mode, "passed": True, "panelRow": panel_row, "activeUpdates": len(bodies), "wheelAnchorVerified": mode == "fullscreen", "activeAndIdleClearScrollback": False})
        print(json.dumps(summaries[-1]), flush=True)
        process.write("/quit\r")
        deadline = time.monotonic() + 8
        while process.isalive() and time.monotonic() < deadline:
            readable, _, _ = select.select([process.fileobj], [], [], 0.1)
            if readable:
                try:
                    raw.append(process.read(65536))
                except EOFError:
                    break
    finally:
        (evidence / "ansi.log").write_text("".join(raw), encoding="utf-8")
        (evidence / "last-screen.txt").write_text("\n".join(screen.display), encoding="utf-8")
        if process is not None:
            process.close(force=True)
            print(json.dumps({"mode": mode, "stage": "cleanup", "pid": process.pid, "alive": process.isalive()}), flush=True)
(root / "live-pty-results.json").write_text(json.dumps(summaries, indent=2), encoding="utf-8")
print(f"LIVE_PTY_PASS {root.as_posix()}", flush=True)
