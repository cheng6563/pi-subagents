"""Real Pi inspector regression in Windows ConPTY, regular and fullscreen.
Uses ui.mts fixtures only; no model calls, real child tasks or production sessions.
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
run_path = Path(fixture["activeRun"])
run = json.loads(run_path.read_text(encoding="utf-8"))
run.update(status="running", pid=os.getpid())
run_path.write_text(json.dumps(run), encoding="utf-8")
contract_path = Path(run["dir"]) / "contract.json"
contract = json.loads(contract_path.read_text(encoding="utf-8"))
contract["task"] = "INSPECTOR_TASK。\n" + "\n".join(f"PROMPT_{i:03}" for i in range(120))
contract_path.write_text(json.dumps(contract), encoding="utf-8")
reply = "\n".join(f"REPLY_{i:03}" for i in range(120))
results = []


def message(role, text):
    return json.dumps({"type": "message", "message": {"role": role, "content": text}}, ensure_ascii=False) + "\n"


def save_progress(text, tools=2, current_tool=None, tool_output=""):
    path = Path(fixture["progress"])
    staging = path.with_suffix(".inspector-update")
    try:
        staging.write_text(json.dumps({"activity": "输出中", "text": text, "previewText": text, "tools": tools, "currentTool": current_tool, "toolOutput": tool_output, "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}, ensure_ascii=False), encoding="utf-8")
        staging.replace(path)
    finally:
        staging.unlink(missing_ok=True)


def position(text, tab="会话"):
    match = re.search(rf"{tab} (\d+)–(\d+)/(\d+)", text)
    return tuple(map(int, match.groups())) if match else None


for mode in ("regular", "fullscreen"):
    evidence = root / f"inspector-{mode}"
    evidence.mkdir(exist_ok=True)
    parent_session = evidence / "session.jsonl"
    shutil.copyfile(fixture["session"], parent_session)
    Path(run["sessionFile"]).write_text(message("user", contract["task"]) + message("assistant", reply), encoding="utf-8")
    save_progress("")
    env = dict(os.environ, PI_CODING_AGENT_DIR=fixture["agentDir"], LOCALAPPDATA=fixture["root"], PI_OFFLINE="1", PI_TELEMETRY="0", TERM="xterm-256color")
    argv = [shutil.which("node"), fixture["cli"], "--offline", "--session", str(parent_session), "--provider", "fixture", "--model", "parent", "--no-extensions", "-e", fixture["extension"], "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--tui-mode", mode]
    process = None
    screen = pyte.Screen(120, 50)
    stream = pyte.Stream(screen)
    raw = []
    synchronized = {"active": False, "tail": ""}

    def pump():
        assert process.isalive(), f"Pi exited: {process.exitstatus}"
        ready, _, _ = select.select([process.fileobj], [], [], .1)
        if ready:
            text = process.read(65536)
            raw.append(text)
            stream.feed(text)
            protocol = synchronized["tail"] + text
            for token in re.finditer(r"\x1b\[\?2026([hl])", protocol):
                synchronized["active"] = token.group(1) == "h"
            synchronized["tail"] = protocol[-32:]
            if "\x1b[6n" in text:
                process.write(f"\x1b[{screen.cursor.y + 1};{screen.cursor.x + 1}R")

    def wait_for(predicate, name, timeout=30):
        deadline = time.monotonic() + timeout
        previous = None
        while time.monotonic() < deadline:
            pump()
            text = "\n".join(screen.display)
            if not synchronized["active"] and predicate(text) and text == previous:
                (evidence / f"{name}.txt").write_text(text, encoding="utf-8")
                print(json.dumps({"mode": mode, "stage": name, "status": "passed"}), flush=True)
                return text
            previous = text
        raise AssertionError(f"Timed out: {mode}/{name}")

    try:
        process = PtyProcess.spawn(argv, cwd=fixture["root"], env=env, dimensions=(50, 120))
        (evidence / "process.json").write_text(json.dumps({"pid": process.pid, "argv": argv}), encoding="utf-8")
        print(json.dumps({"mode": mode, "stage": "spawn", "pid": process.pid}), flush=True)
        wait_for(lambda text: "INSPECTOR_TASK" in text, "dock")
        process.write("/subagents\r")
        latest = wait_for(lambda text: "subagents 运行详情" in text and "REPLY_119" in text and "跟随最新" in text, "latest-conversation")
        lines = latest.splitlines()
        top = next(i for i, line in enumerate(lines) if line.startswith("┌"))
        bottom = next(i for i, line in enumerate(lines) if line.startswith("└"))
        assert bottom - top + 1 == 45
        assert all(re.match(r"[┌├│└].*[┐┤│┘]\s*$", line) for line in lines[top:bottom + 1])
        assert not re.search(r"^│ PROMPT_", latest, re.M)
        assert "r 刷新" not in latest
        original = position(latest)
        process.write("\x1b[5~")
        previous = wait_for(lambda text: position(text) and position(text)[0] < original[0], "page-up")
        anchor = position(previous)
        with Path(run["sessionFile"]).open("a", encoding="utf-8") as file:
            file.write(message("assistant", "LIVE_ADDED_TO_SESSION"))
        save_progress("", tools=3)
        updated = wait_for(lambda text: position(text) and "tools 3" in text, "automatic-update")
        assert position(updated) == anchor, "History mode must keep its content snapshot until End"
        assert re.findall(r"REPLY_\d+", updated) == re.findall(r"REPLY_\d+", previous), "New messages must not pull the visible content away"
        if mode == "fullscreen":
            process.write("\x1b[<64;30;25M")
            wheel = wait_for(lambda text: position(text) and position(text)[0] == anchor[0] - 3, "wheel-up")
            process.write("\x1b[<65;30;25M")
            wait_for(lambda text: position(text) and position(text)[0] == anchor[0], "wheel-down")
        process.write("\x1b[6~")
        wait_for(lambda text: position(text) and position(text)[0] > anchor[0], "page-down")
        process.write("\x1b[F")
        wait_for(lambda text: "LIVE_ADDED_TO_SESSION" in text and "跟随最新" in text, "end-follow")
        save_progress("LIVE_STREAMING_DELTA")
        wait_for(lambda text: "LIVE_STREAMING_DELTA" in text, "streaming-without-session-flush")
        process.write("3")
        task = wait_for(lambda text: "[3 任务]" in text and "任务提示" in text and "PROMPT_000" in text, "task-tab")
        assert "REPLY_119" not in task
        task_position = position(task, "任务")
        process.write("\x1b[6~")
        wait_for(lambda text: position(text, "任务") and position(text, "任务")[0] > task_position[0], "task-page-down")
        process.write("\x1b[H")
        wait_for(lambda text: position(text, "任务") and position(text, "任务")[0] == 1, "home")
        process.write("2")
        wait_for(lambda text: "[2 输出]" in text and "LIVE_STREAMING_DELTA" in text, "output-tab")
        save_progress("LIVE_STREAMING_DELTA", current_tool="bash", tool_output="LIVE_TOOL_LOG")
        wait_for(lambda text: "工具 · bash · 运行中" in text and "LIVE_TOOL_LOG" in text, "tool-output-tab")
        process.write("1")
        wait_for(lambda text: "[1 会话]" in text and "LIVE_TOOL_LOG" in text, "tool-conversation-tab")
        with Path(run["sessionFile"]).open("a", encoding="utf-8") as file:
            file.write(message("toolResult", "LIVE_TOOL_LOG"))
        save_progress("")
        settled_tool = wait_for(lambda text: "LIVE_TOOL_LOG" in text and "工具 · bash · 运行中" not in text, "tool-result-persisted")
        assert settled_tool.count("LIVE_TOOL_LOG") == 1
        process.write("\x1b[C")
        wait_for(lambda text: "深度 2/2" in text and "LIVE_STREAMING_DELTA" not in text, "switch-agent")
        process.write("\x1b[D")
        wait_for(lambda text: "深度 1/2" in text and "LIVE_TOOL_LOG" in text, "switch-back")
        save_progress("LIVE_STREAMING_DELTA")
        wait_for(lambda text: "LIVE_STREAMING_DELTA" in text, "live-before-close")
        process.write("\x1b")
        wait_for(lambda text: "subagents 运行详情" not in text and "LIVE_STREAMING_DELTA" in text, "close-restores-dock")
        results.append({"mode": mode, "passed": True, "paging": True, "latestConversation": True, "framedRows": 45, "automaticUpdateKeepsAnchor": True, "wheel": mode == "fullscreen"})
        process.write("/quit\r")
        deadline = time.monotonic() + 8
        while process.isalive() and time.monotonic() < deadline:
            ready, _, _ = select.select([process.fileobj], [], [], .1)
            if ready:
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
(root / "inspector-results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
print(f"INSPECTOR_PTY_PASS {root.as_posix()}", flush=True)
