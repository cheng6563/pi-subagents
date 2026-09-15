"""Exercise real Windows rename denial while the child streams 101 lines."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading

root = Path(tempfile.mkdtemp(prefix="subagent-progress-lock-"))
expected_failure = "--expect-failure" in sys.argv
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel.CreateFileW.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.CloseHandle.restype = wintypes.BOOL
messages = queue.Queue()
child = None
handle = None
reader = None

def receive():
    try:
        value = messages.get(timeout=10)
    except queue.Empty:
        raise AssertionError("Timed out waiting for child stage")
    if value is None:
        raise EOFError("Child exited before completing streaming")
    return json.loads(value)

def capture():
    for line in child.stdout:
        messages.put(line)
    messages.put(None)

try:
    with (root / "stderr.log").open("w", encoding="utf-8") as log:
        child = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", str(Path(__file__).with_suffix(".mjs")), str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8")
        (root / "process.json").write_text(json.dumps({"pid": child.pid}), encoding="utf-8")
        print(json.dumps({"stage": "spawn", "pid": child.pid, "evidence": root.as_posix()}), flush=True)
        reader = threading.Thread(target=capture, daemon=True)
        reader.start()
        assert receive()["stage"] == "ready"
        # Permit reads/writes, but deny replacement/deletion of this exact display snapshot.
        handle = kernel.CreateFileW(str(root / "progress.json"), 0x80000000, 0x1 | 0x2, None, 3, 0x80, None)
        assert handle != ctypes.c_void_p(-1).value, ctypes.get_last_error()
        child.stdin.write("start\n")
        child.stdin.flush()
        if expected_failure:
            try:
                receive()
                raise AssertionError("Expected the unfixed timer to terminate the process")
            except EOFError:
                assert child.wait(timeout=5) == 1
            assert "EPERM" in (root / "stderr.log").read_text(encoding="utf-8")
            print("REPRODUCED_UNCAUGHT_EPERM", flush=True)
        else:
            assert receive() == {"stage": "streamed", "lines": 101}
            assert child.poll() is None, "A display-only write must not kill the worker"
            assert json.loads((root / "progress.json").read_text(encoding="utf-8"))["text"] == "", "Locked snapshot should remain intact"
            assert not list(root.glob("*.tmp")), "Failed snapshots must not leak temporary files"
            kernel.CloseHandle(handle)
            handle = None
            child.stdin.write("finish\n")
            child.stdin.flush()
            assert receive()["stage"] == "finished"
            child.stdin.close()
            assert child.wait(timeout=5) == 0
            output = (root / "output.md").read_text(encoding="utf-8")
            assert output == "\n".join(f"{i:03}" for i in range(101))
            assert json.loads((root / "progress.json").read_text(encoding="utf-8"))["text"] == output
            logs = (root / "stderr.log").read_text(encoding="utf-8")
            assert "progress_snapshot_failed" in logs and "progress_snapshot_recovered" in logs
            (root / "results.json").write_text(json.dumps({"passed": True, "lines": 101, "newlines": output.count("\n")}), encoding="utf-8")
            print(f"PROGRESS_LOCK_PASS {root.as_posix()}", flush=True)
finally:
    if handle not in (None, ctypes.c_void_p(-1).value):
        kernel.CloseHandle(handle)
    if child:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        child.stdin.close()
        child.stdout.close()
        if reader:
            reader.join(timeout=2)
        print(json.dumps({"stage": "cleanup", "pid": child.pid, "exitCode": child.returncode}), flush=True)
