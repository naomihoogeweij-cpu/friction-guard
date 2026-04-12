#!/usr/bin/env python3
"""friction-guard-inspect — Self-inspection tool for Rutka.

Reads friction-guard incident logs, interaction profiles, and strain policy
as separate data sources, clearly labelled, so Rutka can distinguish between
user-friction detection (friction-guard plugin) and agent operational strain
(agent_strain_policy).

Usage:
  python3 friction_guard_inspect.py status [--user USER_ID]
  python3 friction_guard_inspect.py incidents [--user USER_ID] [--last N] [--min-level L]
  python3 friction_guard_inspect.py profile [--user USER_ID]
  python3 friction_guard_inspect.py explain

Default USER_ID: +31644693379 (Naomi)
"""

from __future__ import annotations

import json
import sys
import os
from datetime import datetime, timezone
from pathlib import Path

MEMORY_DIR = Path.home() / ".openclaw" / "workspace" / "memory"
PROFILE_DIR = MEMORY_DIR / "interaction-profiles"
INCIDENT_DIR = MEMORY_DIR / "incident-logs"
STRAIN_SCRIPT = Path.home() / ".openclaw" / "workspace" / "scripts" / "agent_strain_policy.py"

DEFAULT_USER = "+31644693379"


def load_json(path: Path) -> dict | list | None:
    if not path.exists():
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        print(f"[error] Could not read {path}: {e}", file=sys.stderr)
        return None


def fmt_ts(ts_str: str) -> str:
    """Format ISO timestamp to readable local-ish string."""
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    except Exception:
        return ts_str


def cmd_status(user_id: str):
    """Combined overview: profile + last 5 incidents."""
    print("=" * 60)
    print("FRICTION GUARD STATUS")
    print(f"User: {user_id}")
    print(f"Timestamp: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print("=" * 60)

    # Profile
    profile = load_json(PROFILE_DIR / f"{user_id}.json")
    if profile:
        print(f"\n--- INTERACTION PROFILE ---")
        print(f"Current friction level: {profile.get('currentFrictionLevel', '?')}")
        print(f"Last updated: {fmt_ts(profile.get('updatedAt', '?'))}")

        sigs = profile.get("signatures", {})
        active_sigs = {k: v for k, v in sorted(sigs.items(), key=lambda x: -x[1]) if v > 0}
        if active_sigs:
            print(f"Signature scores:")
            for sig, val in active_sigs.items():
                bar = "█" * int(val * 20) + "░" * (20 - int(val * 20))
                print(f"  {sig:<28} {val:.2f} {bar}")

        constraints = profile.get("constraints", [])
        active_c = [c for c in constraints if c.get("enabled")]
        if active_c:
            print(f"Active constraints ({len(active_c)}):")
            for c in active_c:
                print(f"  {c['id']:<35} conf={c.get('confidence', '?'):.2f}  last={fmt_ts(c.get('lastTriggered', '?'))}")

        bans = profile.get("bannedPhrases", [])
        active_bans = [b for b in bans if b.get("expiresAt", "") > datetime.now(timezone.utc).isoformat()]
        if active_bans:
            print(f"Active bans ({len(active_bans)}):")
            for b in active_bans:
                print(f"  \"{b['phrase']}\" (sev={b.get('severity', '?')}, expires={fmt_ts(b.get('expiresAt', '?'))})")
        elif bans:
            print(f"Bans: {len(bans)} total, all expired")
        else:
            print(f"Bans: none")
    else:
        print(f"\n[!] No profile found for {user_id}")

    # Recent incidents
    incident_data = load_json(INCIDENT_DIR / f"{user_id}.json")
    if incident_data:
        fragments = incident_data.get("fragments", [])
        recent = fragments[-5:]
        print(f"\n--- LAST 5 INCIDENTS (of {len(fragments)} total) ---")
        for f in recent:
            level = f.get("level", 0)
            level_label = ["○ calm", "◐ subtle", "● moderate", "◉ HIGH"][min(level, 3)]
            markers = f.get("markers", [])
            text = f.get("text", "")[:100].replace("\n", " ")
            constraints = f.get("constraintsActivated", [])
            bd = f.get("baselineDeviation", 0)
            print(f"\n  {fmt_ts(f.get('timestamp', '?'))}  {level_label}")
            if markers:
                print(f"    markers: {', '.join(markers)}")
            if constraints:
                print(f"    constraints: {', '.join(constraints)}")
            if bd > 0:
                print(f"    baseline deviation: {bd:.2f}")
            print(f"    text: {text}")
    else:
        print(f"\n[!] No incident log found for {user_id}")

    # Disambiguation note
    print(f"\n--- IMPORTANT ---")
    print(f"This is FRICTION GUARD data (user-facing interaction quality).")
    print(f"This is NOT agent_strain_policy data (infra operational metrics).")
    print(f"These are two independent systems measuring different things.")


def cmd_incidents(user_id: str, last: int = 10, min_level: int = 0):
    """Show incident fragments with optional filtering."""
    print(f"FRICTION GUARD INCIDENTS — user={user_id}, last={last}, min_level={min_level}")
    print("=" * 60)

    incident_data = load_json(INCIDENT_DIR / f"{user_id}.json")
    if not incident_data:
        print(f"[!] No incident log found for {user_id}")
        return

    fragments = incident_data.get("fragments", [])
    filtered = [f for f in fragments if f.get("level", 0) >= min_level]

    print(f"Total fragments: {len(fragments)}")
    print(f"Matching filter (level >= {min_level}): {len(filtered)}")

    # Level distribution
    levels = {}
    for f in fragments:
        l = f.get("level", 0)
        levels[l] = levels.get(l, 0) + 1
    print(f"Distribution: " + ", ".join(f"L{k}={v}" for k, v in sorted(levels.items())))

    # Marker frequency
    marker_freq = {}
    for f in fragments:
        for m in f.get("markers", []):
            marker_freq[m] = marker_freq.get(m, 0) + 1
    if marker_freq:
        print(f"Top markers: " + ", ".join(f"{k}={v}" for k, v in sorted(marker_freq.items(), key=lambda x: -x[1])[:8]))

    shown = filtered[-last:]
    print(f"\nShowing last {len(shown)}:\n")

    for f in shown:
        level = f.get("level", 0)
        level_label = ["○", "◐", "●", "◉"][min(level, 3)]
        markers = f.get("markers", [])
        text = f.get("text", "")[:120].replace("\n", " ")
        constraints = f.get("constraintsActivated", [])
        bd = f.get("baselineDeviation", 0)

        print(f"  {fmt_ts(f.get('timestamp', '?'))}  L{level} {level_label}")
        if markers:
            print(f"    markers: {', '.join(markers)}")
        if constraints:
            print(f"    constraints: {', '.join(constraints)}")
        if bd > 0:
            print(f"    baseline_dev: {bd:.2f}")
        print(f"    \"{text}\"")
        print()


def cmd_profile(user_id: str):
    """Full profile dump."""
    print(f"FRICTION GUARD PROFILE — user={user_id}")
    print("=" * 60)

    profile = load_json(PROFILE_DIR / f"{user_id}.json")
    if not profile:
        print(f"[!] No profile found for {user_id}")
        return

    print(json.dumps(profile, indent=2, ensure_ascii=False))


CONSTRAINT_DESCRIPTIONS_NL = {
    "BAN_CLICHE_PHRASES": "geen clichés",
    "NO_UNASKED_ADVICE_EMOTIONAL": "geen ongevraagd advies",
    "DEFAULT_PROSE": "lopende tekst, geen bullets",
    "MAX_LEN_600": "kort houden",
    "NO_HELPDESK": "geen helpdesktoon",
    "NO_REPETITION": "niet herhalen",
    "EXECUTE_FIRST": "eerst handelen, dan praten",
}

LEVEL_DESCRIPTIONS_NL = {
    0: "geen frictie",
    1: "lichte frictie",
    2: "duidelijke frictie",
    3: "hoge frictie",
}

MARKER_DESCRIPTIONS_NL = {
    "L1-001": "subtiel signaal",
    "L2-003": "escalatie-uitdrukking",
    "L3-001": "vijandige benaming",
    "L3-002": "grove taal",
    "USER-FORCED-REPEAT": "gedwongen herhaling",
}


def cmd_summary(user_id: str):
    """Pre-interpreted summary — relay-ready, no interpretation needed."""

    profile = load_json(PROFILE_DIR / f"{user_id}.json")
    incident_data = load_json(INCIDENT_DIR / f"{user_id}.json")

    if not profile or not incident_data:
        print("Geen data beschikbaar.")
        return

    fragments = incident_data.get("fragments", [])
    level = profile.get("currentFrictionLevel", 0)
    level_desc = LEVEL_DESCRIPTIONS_NL.get(level, f"level {level}")

    constraints = profile.get("constraints", [])
    active_c = [c for c in constraints if c.get("enabled")]
    constraint_names = [CONSTRAINT_DESCRIPTIONS_NL.get(c["id"], c["id"]) for c in active_c]

    recent = fragments[-10:]
    recent_levels = {}
    for f in recent:
        l = f.get("level", 0)
        recent_levels[l] = recent_levels.get(l, 0) + 1

    recent_markers = {}
    for f in recent:
        for m in f.get("markers", []):
            label = MARKER_DESCRIPTIONS_NL.get(m, m)
            recent_markers[label] = recent_markers.get(label, 0) + 1

    high_recent = [f for f in fragments[-20:] if f.get("level", 0) >= 2]

    print(f"Huidig frictieniveau: {level} ({level_desc}).")
    print()

    if constraint_names:
        print(f"Actieve gedragsregels: {', '.join(constraint_names)}.")
    else:
        print("Geen actieve gedragsregels.")
    print()

    print(f"Laatste 10 berichten:")
    for l in sorted(recent_levels.keys()):
        desc = LEVEL_DESCRIPTIONS_NL.get(l, f"level {l}")
        print(f"  {recent_levels[l]}x {desc}")
    print()

    if recent_markers:
        print("Wat er speelde:")
        for label, count in sorted(recent_markers.items(), key=lambda x: -x[1]):
            print(f"  {count}x {label}")
        print()

    if high_recent:
        last_high = high_recent[-1]
        ts = fmt_ts(last_high.get("timestamp", "?"))
        text = last_high.get("text", "")[:80].replace("\n", " ")
        hlevel = last_high.get("level", 0)
        hdesc = LEVEL_DESCRIPTIONS_NL.get(hlevel, f"level {hlevel}")
        hconstraints = last_high.get("constraintsActivated", [])
        hc_names = [CONSTRAINT_DESCRIPTIONS_NL.get(c, c) for c in hconstraints]
        print(f"Laatste frictie-event ({hdesc}):")
        print(f"  \"{text}\"")
        print(f"  tijdstip: {ts}")
        if hc_names:
            print(f"  getriggerde regels: {', '.join(hc_names)}")
    else:
        print("Geen recente frictie-events.")

    total = len(fragments)
    all_levels = {}
    for f in fragments:
        l = f.get("level", 0)
        all_levels[l] = all_levels.get(l, 0) + 1
    print()
    print(f"(Totaal in log: {total} fragments -- " + ", ".join(f"L{k}={v}" for k, v in sorted(all_levels.items())) + ")")



def cmd_explain():
    """Explain the difference between friction-guard and strain policy."""
    print("""
FRICTION GUARD vs AGENT STRAIN POLICY — Architecture Note
==========================================================

These are TWO INDEPENDENT SYSTEMS. Do not confuse them.

1. FRICTION GUARD (plugin: friction-guard, v4.1.0)
   Location: /root/.openclaw/extensions/friction-guard/index.ts
   Data:     /root/.openclaw/workspace/memory/interaction-profiles/
             /root/.openclaw/workspace/memory/incident-logs/
   Measures: USER-FACING INTERACTION QUALITY
   Signals:  - Pattern matching (profanity, hostility, sarcasm, corrections)
             - Grievance Dictionary (stemmed NL/EN word lists)
             - Baseline deviation (message length, sentence count, caps, punctuation)
             - Structural markers (greeting dropout, message shortening)
             - Repetition detection (forced repeats, agent phrase repetition)
   Output:   Constraint injection into system prompt, incident logging

2. AGENT STRAIN POLICY (script: agent_strain_policy.py)
   Location: /root/.openclaw/workspace/scripts/agent_strain_policy.py
   Measures: AGENT OPERATIONAL / INFRASTRUCTURE STRESS
   Signals:  - retry_rate (API call retries)
             - deliberation_cycles (reasoning loops)
             - latency_p95_ms (response latency)
             - escalation_count (error escalations)
   Output:   strain score (0-1), mode (flow/guarded/recover),
             allowed_actions list
   Note:     Runs in SHADOW mode — computes but does not block.

KEY INSIGHT: A low strain score (e.g. 0.062) means the AGENT is
operationally healthy. It says NOTHING about whether the USER is
frustrated. For user friction, inspect friction-guard data.

SELF-INSPECTION:
  python3 scripts/friction_guard_inspect.py status
  python3 scripts/friction_guard_inspect.py incidents --last 10 --min-level 2
  python3 scripts/friction_guard_inspect.py profile
  python3 scripts/friction_guard_inspect.py explain
""")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Friction Guard self-inspection tool")
    sub = parser.add_subparsers(dest="command")

    p_status = sub.add_parser("status", help="Combined profile + recent incidents overview")
    p_status.add_argument("--user", default=DEFAULT_USER)

    p_incidents = sub.add_parser("incidents", help="Show incident fragments")
    p_incidents.add_argument("--user", default=DEFAULT_USER)
    p_incidents.add_argument("--last", type=int, default=10)
    p_incidents.add_argument("--min-level", type=int, default=0)

    p_profile = sub.add_parser("profile", help="Full profile dump")
    p_profile.add_argument("--user", default=DEFAULT_USER)

    p_summary = sub.add_parser("summary", help="Pre-interpreted summary, relay-ready")
    p_summary.add_argument("--user", default=DEFAULT_USER)

    sub.add_parser("explain", help="Explain friction-guard vs strain policy")

    args = parser.parse_args()

    if args.command == "status":
        cmd_status(args.user)
    elif args.command == "incidents":
        cmd_incidents(args.user, args.last, args.min_level)
    elif args.command == "profile":
        cmd_profile(args.user)
    elif args.command == "summary":
        cmd_summary(args.user)
    elif args.command == "explain":
        cmd_explain()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
