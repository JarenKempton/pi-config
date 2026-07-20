#!/usr/bin/env python3
"""Run a Codex app-server turn with native macOS Computer Use.

Unlike `codex exec`, this client handles the Computer Use MCP's per-app
elicitation request. Only explicitly allow-listed apps are approved, and each
approval is session-scoped (the response does not request persistence).
"""

from __future__ import annotations

import argparse
import base64
import fcntl
import json
import mimetypes
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

BUNDLED_CODEX = Path("/Applications/ChatGPT.app/Contents/Resources/codex")
PLUGIN_CACHE = Path.home() / ".codex/plugins/cache/openai-bundled/computer-use"
APPROVAL_RE = re.compile(r"^Allow ChatGPT to use (?P<app>.+)\?$")


def version_key(path: Path) -> tuple[int, ...]:
    numbers = re.findall(r"\d+", path.name)
    return tuple(int(number) for number in numbers) or (0,)


def find_plugin_root() -> Path:
    candidates = [path for path in PLUGIN_CACHE.glob("*") if path.is_dir()]
    candidates.sort(key=version_key, reverse=True)
    for root in candidates:
        if computer_use_client(root).is_file():
            return root
    fallback = Path.home() / ".codex/.tmp/bundled-marketplaces/openai-bundled/plugins/computer-use"
    if computer_use_client(fallback).is_file():
        return fallback
    raise FileNotFoundError("OpenAI's bundled Codex Computer Use plugin was not found")


def computer_use_client(root: Path) -> Path:
    return root / (
        "Codex Computer Use.app/Contents/SharedSupport/"
        "SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
    )


def verify_openai_signature(path: Path, *, deep: bool = False) -> None:
    verify_command = ["/usr/bin/codesign", "--verify", "--strict"]
    if deep:
        verify_command.append("--deep")
    verify_command.append(str(path))
    verification = subprocess.run(
        verify_command, capture_output=True, text=True, check=False
    )
    if verification.returncode != 0:
        raise RuntimeError(f"Invalid code signature for {path}: {verification.stderr.strip()}")

    details = subprocess.run(
        ["/usr/bin/codesign", "-dv", "--verbose=2", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    if details.returncode != 0 or "TeamIdentifier=2DC432GLL2" not in details.stderr:
        raise RuntimeError(f"{path} is not signed by OpenAI")


def find_codex() -> Path:
    if not BUNDLED_CODEX.is_file():
        raise FileNotFoundError(
            f"The ChatGPT-bundled Codex binary was not found at {BUNDLED_CODEX}"
        )
    verify_openai_signature(BUNDLED_CODEX)
    return BUNDLED_CODEX


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Delegate a native macOS Computer Use task to Codex"
    )
    parser.add_argument(
        "--allow-app",
        action="append",
        default=[],
        metavar="APP",
        help="Exact app display name allowed for this session; repeat as needed",
    )
    parser.add_argument("--cwd", default=os.getcwd(), help="Codex working directory")
    parser.add_argument("--output-dir", help="Directory for screenshots returned by Codex")
    parser.add_argument("--timeout", type=int, default=600, help="Turn timeout in seconds")
    parser.add_argument("prompt", nargs=argparse.REMAINDER, help="Task prompt after --")
    args = parser.parse_args()
    if args.prompt and args.prompt[0] == "--":
        args.prompt = args.prompt[1:]
    prompt = " ".join(args.prompt).strip()
    if not prompt and not sys.stdin.isatty():
        prompt = sys.stdin.read().strip()
    if not prompt:
        parser.error("provide a task prompt after -- or through stdin")
    if not args.allow_app:
        parser.error("at least one --allow-app is required")
    args.prompt = prompt
    return args


def reader(stream: Any, records: queue.Queue[str]) -> None:
    for line in stream:
        records.put(line)


def stderr_reader(stream: Any, tail: list[str], limit: int = 80) -> None:
    for line in stream:
        tail.append(line.rstrip())
        if len(tail) > limit:
            del tail[: len(tail) - limit]


def send(process: subprocess.Popen[str], message: dict[str, Any]) -> None:
    assert process.stdin is not None
    process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
    process.stdin.flush()


def save_images(item: dict[str, Any], output_dir: Path, images: list[str]) -> None:
    result = item.get("result") or {}
    for content in result.get("content") or []:
        if content.get("type") != "image" or not content.get("data"):
            continue
        mime_type = content.get("mimeType") or "image/png"
        extension = mimetypes.guess_extension(mime_type) or ".png"
        if extension == ".jpe":
            extension = ".jpg"
        path = output_dir / f"computer-use-{len(images) + 1:03d}{extension}"
        path.write_bytes(base64.b64decode(content["data"]))
        images.append(str(path))


def approval_policy() -> dict[str, Any]:
    return {
        "granular": {
            "sandbox_approval": False,
            "rules": False,
            "skill_approval": False,
            "request_permissions": False,
            "mcp_elicitations": True,
        }
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    codex = find_codex()
    plugin_root = find_plugin_root()
    computer_use_app = plugin_root / "Codex Computer Use.app"
    verify_openai_signature(computer_use_app, deep=True)
    client = computer_use_client(plugin_root)
    output_dir = Path(args.output_dir).expanduser() if args.output_dir else Path(
        tempfile.mkdtemp(prefix="pi-codex-computer-use-")
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    command = [
        str(codex),
        "-c",
        "mcp_servers.computer-use.enabled=true",
        "-c",
        f'mcp_servers.computer-use.command="{client}"',
        "-c",
        f'mcp_servers.computer-use.cwd="{plugin_root}"',
        "app-server",
        "--listen",
        "stdio://",
    ]

    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None and process.stderr is not None
    records: queue.Queue[str] = queue.Queue()
    stderr_tail: list[str] = []
    threading.Thread(target=reader, args=(process.stdout, records), daemon=True).start()
    threading.Thread(
        target=stderr_reader, args=(process.stderr, stderr_tail), daemon=True
    ).start()

    allowed = set(args.allow_app)
    approved_apps: list[str] = []
    denied_elicitations: list[str] = []
    confirmations_required: list[dict[str, Any]] = []
    images: list[str] = []
    final_message = ""
    thread_id: str | None = None
    turn_id: str | None = None
    turn_status: str | None = None
    turn_error: Any = None
    started = time.monotonic()

    send(
        process,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "pi-codex-computer-use", "version": "0.1"},
                "capabilities": {
                    "experimentalApi": True,
                    "mcpServerOpenaiFormElicitation": True,
                },
            },
        },
    )

    try:
        while time.monotonic() - started < args.timeout:
            try:
                line = records.get(timeout=0.25)
            except queue.Empty:
                if process.poll() is not None:
                    break
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue

            request_id = message.get("id")
            method = message.get("method")

            if request_id == 1 and "result" in message:
                send(process, {"jsonrpc": "2.0", "method": "initialized", "params": {}})
                send(
                    process,
                    {
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "thread/start",
                        "params": {
                            "cwd": str(Path(args.cwd).expanduser().resolve()),
                            "ephemeral": True,
                            "sandbox": "read-only",
                            "approvalPolicy": approval_policy(),
                            "developerInstructions": (
                                "For native macOS UI tasks, use only the direct computer-use MCP "
                                "server. Do not use node_repl, browser tools, shell UI automation, "
                                "AppleScript, osascript, or system APIs as substitutes. Follow the "
                                "Computer Use confirmation policy. Return a concise final report."
                            ),
                        },
                    },
                )
            elif request_id == 2 and "error" in message:
                turn_error = message["error"]
                break
            elif request_id == 2 and "result" in message:
                result = message["result"]
                thread = result.get("thread") or result
                thread_id = thread.get("id") or result.get("threadId")
                send(
                    process,
                    {
                        "jsonrpc": "2.0",
                        "id": 3,
                        "method": "turn/start",
                        "params": {
                            "threadId": thread_id,
                            "input": [{"type": "text", "text": args.prompt}],
                        },
                    },
                )
            elif request_id == 3 and "error" in message:
                turn_error = message["error"]
                break
            elif method == "turn/started":
                turn = (message.get("params") or {}).get("turn") or {}
                turn_id = turn.get("id")
            elif method == "mcpServer/elicitation/request" and request_id is not None:
                params = message.get("params") or {}
                match = APPROVAL_RE.match(params.get("message", ""))
                app = match.group("app") if match else None
                is_computer_use = params.get("serverName") == "computer-use"
                if is_computer_use and app and app in allowed:
                    approved_apps.append(app)
                    response = {"action": "accept"}
                else:
                    denied_elicitations.append(params.get("message", "Unknown elicitation"))
                    response = {"action": "decline"}
                send(
                    process,
                    {"jsonrpc": "2.0", "id": request_id, "result": response},
                )
            elif method in {
                "item/tool/requestUserInput",
                "item/permissions/requestApproval",
                "item/commandExecution/requestApproval",
                "item/fileChange/requestApproval",
            } and request_id is not None:
                params = message.get("params") or {}
                confirmations_required.append({"method": method, "params": params})
                send(
                    process,
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {
                            "code": -32000,
                            "message": "User confirmation must be handled by the calling Pi agent",
                        },
                    },
                )
            elif method == "item/completed":
                item = (message.get("params") or {}).get("item") or {}
                if item.get("type") == "mcpToolCall":
                    save_images(item, output_dir, images)
                elif item.get("type") == "agentMessage" and item.get("phase") == "final_answer":
                    final_message = item.get("text") or final_message
            elif method == "turn/completed":
                turn = (message.get("params") or {}).get("turn") or {}
                turn_id = turn.get("id") or turn_id
                turn_status = turn.get("status")
                turn_error = turn.get("error")
                break
        else:
            turn_error = {"message": f"Timed out after {args.timeout} seconds"}
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()

    ok = turn_status == "completed" and not turn_error
    return {
        "ok": ok,
        "status": turn_status,
        "final_message": final_message,
        "images": images,
        "approved_apps": approved_apps,
        "denied_elicitations": denied_elicitations,
        "confirmations_required": confirmations_required,
        "thread_id": thread_id,
        "turn_id": turn_id,
        "output_dir": str(output_dir),
        "error": turn_error,
        "stderr_tail": stderr_tail if not ok else [],
    }


def main() -> int:
    args = parse_args()
    lock_path = Path(tempfile.gettempdir()) / "pi-codex-computer-use.lock"
    with lock_path.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            result = run(args)
        except Exception as error:
            result = {
                "ok": False,
                "status": "failed",
                "final_message": "",
                "images": [],
                "approved_apps": [],
                "denied_elicitations": [],
                "confirmations_required": [],
                "error": {"type": type(error).__name__, "message": str(error)},
            }
    print(json.dumps(result, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
