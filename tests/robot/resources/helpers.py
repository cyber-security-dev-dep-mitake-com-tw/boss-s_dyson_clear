"""Keyword helpers for the SweepDeck Robot Framework acceptance suites.

Standard library only (json / hashlib / os / sys / tempfile / re) — no pip
dependencies beyond robotframework itself. All path handling goes through
os.path so the suites run unchanged on macOS, Linux and Windows.
"""

import hashlib
import json
import os
import re
import sys
import tempfile

ROBOT_LIBRARY_SCOPE = "GLOBAL"

_SEP_RE = re.compile(r"[\\/]+")


# -- temp dirs / platform -----------------------------------------------------

def make_temp_dir(prefix="sweepdeck-robot-"):
    """Create a fresh temp directory (never assumes /tmp) and return its path."""
    return tempfile.mkdtemp(prefix=prefix)


def protected_scan_root():
    """The per-OS hard-denied root used by the safety suite."""
    return "C:\\Windows" if sys.platform == "win32" else "/System"


def is_within(child, parent):
    """True when realpath(child) is inside realpath(parent)."""
    child_r = os.path.realpath(child)
    parent_r = os.path.realpath(parent)
    rel = os.path.relpath(child_r, parent_r)
    return rel != ".." and not rel.startswith(".." + os.sep) and not os.path.isabs(rel)


# -- JSON / JSONL parsing -------------------------------------------------------

def parse_jsonl(text):
    """Parse every non-empty line as JSON; raises on any unparseable line."""
    docs = []
    for i, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            docs.append(json.loads(line))
        except ValueError as err:
            raise AssertionError(f"line {i} is not valid JSON ({err}): {line[:200]}")
    return docs


def get_workflow_events(text):
    """WorkflowEvent lines only (excludes the trailing {'type':'summary'} line)."""
    return [d for d in parse_jsonl(text) if d.get("type") != "summary" and "runId" in d]


def get_scan_summary(text):
    """The ScanSummary from the last {'type':'summary','summary':...} line."""
    docs = parse_jsonl(text)
    if not docs:
        raise AssertionError("scan produced no output lines")
    last = docs[-1]
    if last.get("type") != "summary" or "summary" not in last:
        raise AssertionError(f"last line is not a summary line: {json.dumps(last)[:200]}")
    return last["summary"]


def parse_json(text):
    return json.loads(text)


# -- checksums ----------------------------------------------------------------

def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_checksum(root):
    """Deterministic {relative/posix/path: sha256} map of every file in a tree."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out[rel] = file_sha256(full)
    return out


# -- CleanPlan queries ----------------------------------------------------------

def verdicts_of_category(plan, category):
    return [v for v in plan["verdicts"] if v["category"] == category]


def subject_keys(plan, category=None):
    verdicts = plan["verdicts"] if category is None else verdicts_of_category(plan, category)
    return [v["subjectKey"] for v in verdicts]


def path_has_segment(path, segment):
    """Case-insensitive test for a whole path component (works on / and \\)."""
    seg = segment.lower()
    return any(part.lower() == seg for part in _SEP_RE.split(path))


def subjects_with_segment(plan, segment):
    """All verdict subjectKeys that contain the given path component."""
    return [k for k in subject_keys(plan) if path_has_segment(k, segment)]


def find_verdict_by_basename(plan, basename, category=None):
    """The single verdict whose subjectKey ends in basename; error if 0 or >1."""
    verdicts = plan["verdicts"] if category is None else verdicts_of_category(plan, category)
    hits = [v for v in verdicts if os.path.basename(v["subjectKey"]) == basename]
    if len(hits) != 1:
        raise AssertionError(
            f"expected exactly one verdict for {basename!r}, found {len(hits)}: "
            + json.dumps([v["subjectKey"] for v in hits])
        )
    return hits[0]


def duplicate_groups(plan):
    """{groupId: {'members': [subjectKey...], 'canonicals': [canonicalPath...]}}"""
    groups = {}
    for v in verdicts_of_category(plan, "duplicate"):
        gid = v["detail"].get("groupId")
        if gid is None:
            raise AssertionError(f"duplicate verdict without groupId: {json.dumps(v)[:200]}")
        g = groups.setdefault(gid, {"members": [], "canonicals": []})
        g["members"].append(v["subjectKey"])
        canonical = v["detail"].get("canonicalPath")
        if canonical not in g["canonicals"]:
            g["canonicals"].append(canonical)
    return groups
