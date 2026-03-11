"""Quick LuaEvents bridge tester with focused Lua.log inspection."""

from __future__ import annotations

import argparse
import socket
import struct
import time
from pathlib import Path

LOG_PATH = Path.home() / "AppData/Local/Firaxis Games/Sid Meier's Civilization VI/Logs/Lua.log"
LOG_MARKER_PREFIX = "ALPHACIV_LOG_MARKER"

BLOCK_MARKERS = {
    "ALPHACIV_STATE_BEGIN": "ALPHACIV_STATE_END",
    "ALPHACIV_PRODUCTION_BEGIN": "ALPHACIV_PRODUCTION_END",
    "ALPHACIV_DISTRICT_SITES_BEGIN": "ALPHACIV_DISTRICT_SITES_END",
    "ALPHACIV_BUILDING_SITES_BEGIN": "ALPHACIV_BUILDING_SITES_END",
    "ALPHACIV_UNIT_ACTIONS_BEGIN": "ALPHACIV_UNIT_ACTIONS_END",
}


def send_lua(code: str, port: int = 4319) -> bool:
    """Send Lua code via FireTuner."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5.0)
    try:
        sock.connect(("127.0.0.1", port))
        payload = f"CMD:0:{code}\0".encode()
        header = struct.pack("<II", len(payload), 1)
        sock.sendall(header + payload)
        sock.recv(1024)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"Connection error: {exc}")
        return False
    finally:
        sock.close()


def send_command(action: str, *args) -> bool:
    """Send a command via LuaEvents.AlphaCivCommand."""
    args_str = ", ".join(str(arg) for arg in args)
    lua = (
        f'LuaEvents.AlphaCivCommand("{action}", {args_str})'
        if args_str
        else f'LuaEvents.AlphaCivCommand("{action}")'
    )
    print(f"Sending: {lua}")
    return send_lua(lua)


def read_log_tail(lines: int = 120) -> list[str]:
    """Read the last N lines from Lua.log."""
    try:
        with LOG_PATH.open(encoding="utf-8", errors="replace") as handle:
            return handle.readlines()[-lines:]
    except OSError:
        return []


def read_log_all() -> list[str]:
    """Read full Lua.log."""
    try:
        with LOG_PATH.open(encoding="utf-8", errors="replace") as handle:
            return handle.readlines()
    except OSError:
        return []


def clear_log() -> bool:
    """Truncate Lua.log so only fresh events remain."""
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        LOG_PATH.write_text("", encoding="utf-8")
        return True
    except OSError as exc:
        print(f"Could not clear Lua.log: {exc}")
        return False


def emit_log_marker(tag: str | None = None) -> str | None:
    """Emit a unique marker line into Lua.log."""
    timestamp = int(time.time() * 1000)
    suffix = f":{tag}" if tag else ""
    marker = f"{LOG_MARKER_PREFIX}:{timestamp}{suffix}"
    if send_lua(f'print("{marker}")'):
        return marker
    return None


def lines_after_last_match(lines: list[str], needle: str) -> list[str]:
    """Return lines after the last line containing needle."""
    last_index = -1
    for index, line in enumerate(lines):
        if needle in line:
            last_index = index
    if last_index < 0:
        return lines
    return lines[last_index + 1 :]


def format_filtered_log(lines: list[str], include_payload: bool = False) -> list[str]:
    """Keep relevant AlphaCiv entries and collapse noisy JSON payload lines."""
    output: list[str] = []

    active_block_begin: str | None = None
    active_block_end: str | None = None
    hidden_payload_lines = 0

    for raw_line in lines:
        line = raw_line.rstrip("\r\n")
        upper_line = line.upper()

        if active_block_begin is not None:
            if active_block_end and active_block_end in upper_line:
                if not include_payload and hidden_payload_lines > 0:
                    name = active_block_begin.replace("_BEGIN", "")
                    output.append(f"... [{name}] omitted {hidden_payload_lines} payload lines ...")
                output.append(line)
                active_block_begin = None
                active_block_end = None
                hidden_payload_lines = 0
                continue

            if include_payload:
                output.append(line)
            else:
                hidden_payload_lines += 1
            continue

        begin_marker = None
        end_marker = None
        for begin, end in BLOCK_MARKERS.items():
            if begin in upper_line:
                begin_marker = begin
                end_marker = end
                break

        if begin_marker is not None:
            output.append(line)
            active_block_begin = begin_marker
            active_block_end = end_marker
            hidden_payload_lines = 0
            continue

        if not include_payload and "alphaciv_ui_v2:" in line:
            _, _, content = line.partition("alphaciv_ui_v2:")
            content = content.strip()
            if content and content[0] in '{"[':
                continue

        if "alphaciv_ui_v2:" in line:
            lowered_line = line.lower()
            if "alphaciv_" not in upper_line and "alphaciv v2 ui:" not in lowered_line:
                continue

        lowered = line.lower()
        relevant = (
            "alphaciv" in lowered
            or "presets:" in lowered
            or "runtime error" in lowered
            or "attempt to" in lowered
            or "command failed" in lowered
        )
        if relevant:
            output.append(line)

    return output


def print_log(lines: int, raw: bool, include_payload: bool, since: str | None = None) -> None:
    tail = read_log_all() if since else read_log_tail(lines=lines)
    if not tail:
        print("Lua.log is empty or unavailable")
        return

    if since:
        tail = lines_after_last_match(tail, since)
        if not tail:
            print(f"No log lines found after marker: {since}")
            return
        if len(tail) > lines:
            tail = tail[-lines:]

    if raw:
        for line in tail:
            print(line.rstrip("\r\n"))
        return

    filtered = format_filtered_log(tail, include_payload=include_payload)
    if not filtered:
        print("No relevant AlphaCiv lines found in tail")
        return

    for line in filtered:
        print(line)


def main() -> None:
    parser = argparse.ArgumentParser(description="Test LuaEvents bridge")
    parser.add_argument("--ping", action="store_true", help="Send PING command")
    parser.add_argument(
        "--move",
        nargs=3,
        type=int,
        metavar=("UNIT_ID", "X", "Y"),
        help="Move unit to position",
    )
    parser.add_argument("--end-turn", action="store_true", help="End turn")
    parser.add_argument("--log", action="store_true", help="Show recent log")
    parser.add_argument(
        "--log-lines", type=int, default=120, help="How many trailing lines to inspect"
    )
    parser.add_argument("--log-raw", action="store_true", help="Do not filter/collapse log entries")
    parser.add_argument(
        "--log-payload",
        action="store_true",
        help="Show JSON payload lines inside ALPHACIV_* blocks",
    )
    parser.add_argument("--clear-log", action="store_true", help="Truncate Lua.log and exit")
    parser.add_argument(
        "--mark-log", nargs="?", const="", metavar="TAG", help="Emit log marker line"
    )
    parser.add_argument(
        "--since", help="For --log: show only lines after last matching marker text"
    )
    parser.add_argument(
        "--since-last-marker",
        action="store_true",
        help="For --log: use last ALPHACIV_LOG_MARKER entry as boundary",
    )

    args = parser.parse_args()

    if args.clear_log:
        if clear_log():
            print(f"Cleared {LOG_PATH}")
        return

    if args.mark_log is not None:
        marker = emit_log_marker(args.mark_log or None)
        if marker:
            print(f"Marked Lua.log with: {marker}")
        else:
            print("Failed to emit log marker")
        return

    if args.log:
        print("=== Recent Lua.log ===")
        since = args.since
        if args.since_last_marker:
            since = LOG_MARKER_PREFIX
        print_log(
            lines=args.log_lines,
            raw=args.log_raw,
            include_payload=args.log_payload,
            since=since,
        )
        return

    if args.ping:
        print("Sending PING...")
        send_command("PING")
        time.sleep(0.5)
        print("\nChecking log for response...")
        print_log(lines=40, raw=False, include_payload=False)
        return

    if args.move:
        unit_id, x, y = args.move
        print(f"Moving unit {unit_id} to ({x}, {y})...")
        send_command("MOVE", unit_id, x, y)
        time.sleep(0.5)
        print("\nChecking log...")
        print_log(lines=40, raw=False, include_payload=False)
        return

    if args.end_turn:
        print("Ending turn...")
        send_command("END_TURN")
        time.sleep(0.5)
        print("\nChecking log...")
        print_log(lines=40, raw=False, include_payload=False)
        return

    print("=== LuaEvents Bridge Test ===")
    print("\nStep 1: Reload Civ to load the updated mod")
    print(
        "Step 2: Optional clean slate -> uv run python src/harness/python/test_luaevents.py --clear-log"
    )
    print("Step 3: Run a command (for example --ping)")
    print("Step 4: Inspect filtered logs with --log")
    print("\nCommands:")
    print("  --ping                   Send PING test")
    print("  --move ID X Y            Move unit")
    print("  --end-turn               End turn")
    print("  --log                    Show filtered recent log")
    print("  --log --log-raw          Show raw log tail")
    print("  --log --log-payload      Include JSON payload chunks")
    print("  --clear-log              Truncate Lua.log")


if __name__ == "__main__":
    main()
