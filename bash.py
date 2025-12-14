from __future__ import annotations

import json
import subprocess
import sys
from typing import Any, Dict, List, Optional

CommandResult = Dict[str, Any]
DEFAULT_TIMEOUT_SECONDS = 200

# Ordered list of scan functions for CLI and server streaming.
SCAN_FUNCTIONS = [
    "snapshots_search",
    "apfs_search",
    "vm_search",
    "sleep_search",
    "cache_search",
    "dev_data_search",
    "homebrew_search",
    "venv_search",
    "docker_search",
    "backup_search",
    "photo_cache_serch",
    "imove_search",
    "purgeable_search",
    "universal_search",
]

def _human_to_bytes(token: str) -> Optional[int]:
    """Convert a human-friendly size token (e.g., '12G', '512M') to bytes."""
    multipliers = {
        "k": 1024,
        "m": 1024**2,
        "g": 1024**3,
        "t": 1024**4,
        "p": 1024**5,
    }
    token = token.strip()
    if not token:
        return None

    number = ""
    unit = ""
    for char in token:
        if char.isdigit() or char == ".":
            number += char
        else:
            unit += char
    if not number:
        return None

    try:
        value = float(number)
    except ValueError:
        return None

    unit = unit.lower()
    if not unit:
        return int(value)

    normalized = unit[0]
    multiplier = multipliers.get(normalized)
    if multiplier is None:
        return None
    return int(value * multiplier)


def _parse_du_sizes(stdout: str) -> List[Dict[str, Any]]:
    """
    Parse the output of `du -sh` style commands into structured size data.
    Expected line shape: "<size>\t<path>" or "<size> <path>".
    """
    parsed: List[Dict[str, Any]] = []
    for line in stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) < 2:
            continue
        size_human, path = parts
        size_bytes = _human_to_bytes(size_human)
        parsed.append(
            {
                "path": path,
                "size_human": size_human,
                "size_bytes": size_bytes,
            }
        )
    return parsed


def _run_command(
    command: str,
    *,
    category: str,
    path: Optional[str] = None,
    note: Optional[str] = None,
    parse_du: bool = False,
    timeout: Optional[int] = DEFAULT_TIMEOUT_SECONDS,
) -> CommandResult:
    """
    Execute a shell command and return a normalized command result dictionary.

    Parameters
    ----------
    command:
        Shell command to execute.
    category:
        High-level category name for grouping in the UI.
    path:
        Primary path the command targets, if applicable.
    note:
        Extra context for display purposes.
    parse_du:
        When True, attempts to parse `du`-style size output into `parsed_sizes`.
    timeout:
        Soft timeout in seconds for the command; when exceeded, an error result
        is returned with stderr describing the timeout.
    """
    try:
        try:
            completed = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            stdout = completed.stdout.strip()
            stderr = completed.stderr.strip()
            returncode = completed.returncode
        except subprocess.TimeoutExpired as exc:
            stdout = (exc.stdout or "").strip()
            stderr = (exc.stderr or "").strip() or f"Timed out after {timeout} seconds."
            returncode = -1

        parsed_sizes = _parse_du_sizes(stdout) if parse_du else []

        # Normalize outputs for frontend/CLI consistency.
        if returncode == 0 and not stdout:
            stdout = "No files found."
        if returncode != 0 and not stderr:
            stderr = "Command failed without additional details."

        return {
            "category": category,
            "command": command,
            "stdout": stdout,
            "stderr": stderr,
            "returncode": returncode,
            "path": path,
            "note": note,
            "parsed_sizes": parsed_sizes,
            "status": "ok" if returncode == 0 else "error",
        }
    except Exception as exc:
        return {
            "category": category,
            "command": command,
            "stdout": "",
            "stderr": f"Internal execution error: {exc}",
            "returncode": -1,
            "path": path,
            "note": note,
            "parsed_sizes": None,
            "status": "error",
        }


def snapshots_search() -> List[CommandResult]:
    """
    Inspect local Time Machine snapshots and report their presence and sizes.
    Returns two command results: one listing snapshots and another estimating
    their sizes via `diskutil`.
    """
    return [
        _run_command(
            "tmutil listlocalsnapshots /",
            category="snapshots",
            path="/",
            note="List local APFS snapshots created by Time Machine.",
        ),
        _run_command(
            "diskutil apfs listSnapshots / 2>/dev/null | grep -i size || true",
            category="snapshots",
            path="/",
            note="Estimate snapshot sizes reported by diskutil.",
        ),
    ]


def apfs_search() -> List[CommandResult]:
    """
    Review APFS volume metadata to spot storage overhead like purgeable space.
    Returns the raw `diskutil apfs list` output for UI parsing/filtering.
    """
    return [
        _run_command(
            "diskutil apfs list",
            category="apfs",
            note="APFS container and volume breakdown (overhead, purgeable, snapshots).",
        )
    ]


def vm_search() -> List[CommandResult]:
    """
    Measure space consumed by virtual memory swap files under /private/var/vm.
    Returns a `du -sh` size summary and a detailed directory listing.
    """
    return [
        _run_command(
            "test -d /private/var/vm && du -sh /private/var/vm || echo 'No files found.'",
            category="virtual_memory",
            path="/private/var/vm",
            note="Overall size of swap files.",
            parse_du=True,
        ),
        _run_command(
            "ls -lh /private/var/vm 2>/dev/null || echo 'No files found.'",
            category="virtual_memory",
            path="/private/var/vm",
            note="Individual swap files and their sizes.",
        ),
    ]


def sleep_search() -> List[CommandResult]:
    """
    Check for large hibernation artifacts like the sleepimage file.
    Returns the detailed listing for /private/var/vm/sleepimage.
    """
    return [
        _run_command(
            "ls -lh /private/var/vm/sleepimage 2>/dev/null || echo 'No files found.'",
            category="sleep",
            path="/private/var/vm/sleepimage",
            note="Presence and size of the sleepimage file.",
        )
    ]


def cache_search() -> List[CommandResult]:
    """
    Summarize user and system cache directories that commonly balloon in size.
    Returns `du -sh` summaries for ~/Library/Caches and /Library/Caches.
    """
    return [
        _run_command(
            "test -d ~/Library/Caches && du -sh ~/Library/Caches || echo 'No files found.'",
            category="caches",
            path="~/Library/Caches",
            note="User-level caches (Safari, Chrome, apps).",
            parse_du=True,
        ),
        _run_command(
            "test -d /Library/Caches && du -sh /Library/Caches || echo 'No files found.'",
            category="caches",
            path="/Library/Caches",
            note="System-level caches.",
            parse_du=True,
        ),
    ]


def dev_data_search() -> List[CommandResult]:
    """
    Capture Xcode and developer tool footprints known to consume tens of GBs.
    Returns `du -sh` summaries for Developer, DerivedData, CoreSimulator, and Archives.
    """
    return [
        _run_command(
            "test -d ~/Library/Developer && du -sh ~/Library/Developer || echo 'No files found.'",
            category="developer_data",
            path="~/Library/Developer",
            note="Aggregate size of all developer data.",
            parse_du=True,
        ),
        _run_command(
            "test -d ~/Library/Developer/Xcode/DerivedData && du -sh ~/Library/Developer/Xcode/DerivedData || echo 'No files found.'",
            category="developer_data",
            path="~/Library/Developer/Xcode/DerivedData",
            note="Xcode build artifacts (DerivedData).",
            parse_du=True,
        ),
        _run_command(
            "test -d ~/Library/Developer/CoreSimulator && du -sh ~/Library/Developer/CoreSimulator || echo 'No files found.'",
            category="developer_data",
            path="~/Library/Developer/CoreSimulator",
            note="Simulator device images and data.",
            parse_du=True,
        ),
        _run_command(
            "test -d ~/Library/Developer/Xcode/Archives && du -sh ~/Library/Developer/Xcode/Archives || echo 'No files found.'",
            category="developer_data",
            path="~/Library/Developer/Xcode/Archives",
            note="Archived Xcode builds.",
            parse_du=True,
        ),
    ]


def homebrew_search() -> List[CommandResult]:
    """
    Review Homebrew cache and cellar usage, plus a dry-run cleanup preview.
    Returns a cleanup preview alongside cellar/cache size summaries.
    """
    return [
        _run_command(
            "command -v brew >/dev/null 2>&1 && brew cleanup -n || echo 'brew not installed.'",
            category="homebrew",
            note="Preview of files Homebrew can delete (no changes made).",
        ),
        _run_command(
            "du -sh /opt/homebrew/Cellar /usr/local/Cellar 2>/dev/null || echo 'No files found.'",
            category="homebrew",
            path="/opt/homebrew/Cellar",
            note="Installed formulae (Cellar) footprint.",
            parse_du=True,
        ),
        _run_command(
            "test -d ~/Library/Caches/Homebrew && du -sh ~/Library/Caches/Homebrew || echo 'No files found.'",
            category="homebrew",
            path="~/Library/Caches/Homebrew",
            note="Homebrew download/cache storage.",
            parse_du=True,
        ),
    ]


def venv_search() -> List[CommandResult]:
    """
    Inspect common package manager caches and virtual environment directories.
    Returns size summaries for npm, pip, conda/anaconda, and Node modules listings.
    """
    return [
        _run_command(
            "test -d ~/.npm && du -sh ~/.npm || echo 'No files found.'",
            category="package_artifacts",
            path="~/.npm",
            note="npm cache footprint.",
            parse_du=True,
        ),
        _run_command(
            "test -d ~/.cache/pip && du -sh ~/.cache/pip || echo 'No files found.'",
            category="package_artifacts",
            path="~/.cache/pip",
            note="pip cache footprint.",
            parse_du=True,
        ),
        _run_command(
            "du -sh ~/miniconda* ~/anaconda* 2>/dev/null || echo 'No files found.'",
            category="package_artifacts",
            path="~/miniconda* ~/anaconda*",
            note="Conda/Anaconda installations if present.",
            parse_du=True,
        ),
        _run_command(
            "find ~ -maxdepth 4 -name node_modules -type d -prune 2>/dev/null",
            category="package_artifacts",
            path="~",
            note="Node.js module folders (sizes computed separately if desired).",
        ),
    ]


def docker_search() -> List[CommandResult]:
    """
    Surface Docker disk usage, including the Docker data directory footprint.
    Returns `docker system df` plus a size summary of the Docker containers folder.
    """
    return [
        _run_command(
            "command -v docker >/dev/null 2>&1 && docker system df || echo 'docker not installed.'",
            category="docker",
            note="Docker image/container/volume usage summary.",
        ),
        _run_command(
            "du -sh ~/Library/Containers/com.docker.docker 2>/dev/null || echo 'No files found.'",
            category="docker",
            path="~/Library/Containers/com.docker.docker",
            note="Docker for Mac data directory size.",
            parse_du=True,
        ),
    ]


def backup_search() -> List[CommandResult]:
    """
    Measure iOS/iPadOS device backup storage usage.
    Returns a `du -sh` summary for the MobileSync backup directory.
    """
    return [
        _run_command(
            "test -d ~/Library/Application\\ Support/MobileSync && du -sh ~/Library/Application\\ Support/MobileSync || echo 'No files found.'",
            category="backups",
            path="~/Library/Application Support/MobileSync",
            note="Finder/iTunes device backups.",
            parse_du=True,
        )
    ]


def photo_cache_serch() -> List[CommandResult]:
    """
    Report on Photos library storage, a common hidden consumer of disk space.
    Returns a `du -sh` summary for the Photos library bundle.
    """
    return [
        _run_command(
            "test -d ~/Pictures/Photos\\ Library.photoslibrary && du -sh ~/Pictures/Photos\\ Library.photoslibrary || echo 'No files found.'",
            category="photos",
            path="~/Pictures/Photos Library.photoslibrary",
            note="Photos library originals and cache size.",
            parse_du=True,
        )
    ]


def imove_search() -> List[CommandResult]:
    """
    Surface media asset footprints for GarageBand, Logic, and general Movies.
    Returns size summaries for common pro-app and media asset folders.
    """
    return [
        _run_command(
            "test -d /Library/Application\\ Support/GarageBand && du -sh /Library/Application\\ Support/GarageBand || echo 'No files found.'",
            category="media_assets",
            path="/Library/Application Support/GarageBand",
            note="GarageBand loops and sounds.",
            parse_du=True,
        ),
        _run_command(
            "test -d /Library/Application\\ Support/Logic && du -sh /Library/Application\\ Support/Logic || echo 'No files found.'",
            category="media_assets",
            path="/Library/Application Support/Logic",
            note="Logic Pro content libraries.",
            parse_du=True,
        ),
        _run_command(
            "test -d ~/Movies && du -sh ~/Movies || echo 'No files found.'",
            category="media_assets",
            path="~/Movies",
            note="User movie files (including iMovie/Final Cut assets).",
            parse_du=True,
        ),
    ]


def purgeable_search() -> List[CommandResult]:
    """
    Query diskutil for purgeable storage reported by APFS on the root volume.
    Returns the filtered `diskutil info /` output for the Purgeable field.
    """
    return [
        _run_command(
            "diskutil info / 2>/dev/null | grep -i Purgeable || true",
            category="purgeable",
            path="/",
            note="Purgeable storage reported by APFS.",
        )
    ]


def universal_search() -> List[CommandResult]:
    """
    Run broader whole-disk scans to locate large directories or files.
    Combines home-directory breakdown with optional system-wide summaries.
    """
    return [
        _run_command(
            "du -h -d 1 ~ 2>/dev/null | sort -h || echo 'No files found.'",
            category="universal",
            path="~",
            note="Home directory breakdown (sorted ascending).",
        ),
        _run_command(
            "du -h -d 1 / 2>/dev/null | sort -h || echo 'No files found.'",
            category="universal",
            path="/",
            note="Top-level disk breakdown; may need elevated privileges for accuracy.",
        ),
        _run_command(
            "find / -xdev -type f -size +1G -print 2>/dev/null || echo 'No files found.'",
            category="universal",
            path="/",
            note="Files over 1GB (root filesystem, errors suppressed).",
        ),
    ]


def run_all_scans() -> List[CommandResult]:
    """
    Run every scan in order and return a flat list of command results.
    Each scan failure is captured as an error result rather than raising.
    """
    results: List[CommandResult] = []
    for name in SCAN_FUNCTIONS:
        fn = globals().get(name)
        if not callable(fn):
            results.append(
                {
                    "category": name,
                    "command": "",
                    "stdout": "",
                    "stderr": f"Scan function {name} is not callable.",
                    "returncode": -1,
                    "path": None,
                    "note": "Internal configuration error.",
                    "parsed_sizes": None,
                }
            )
            continue
        try:
            results.extend(fn())
        except Exception as exc:  # pragma: no cover - defensive
            results.append(
                {
                    "category": name,
                    "command": "",
                    "stdout": "",
                    "stderr": f"Scan function failed: {exc}",
                    "returncode": -1,
                    "path": None,
                    "note": "Scan aborted unexpectedly.",
                    "parsed_sizes": None,
                }
            )
    return results


def _print_ndjson(results: List[CommandResult]) -> None:
    """Emit results as NDJSON to stdout for CLI usage."""
    for item in results:
        sys.stdout.write(json.dumps(item) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    """
    Running `python bash.py` executes all scans sequentially and prints each
    command result as an NDJSON line to stdout for quick terminal inspection
    or piping into other tools.
    """
    _print_ndjson(run_all_scans())
