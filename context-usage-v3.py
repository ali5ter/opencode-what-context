#!/usr/bin/env python3
"""context-usage-v3.py - Mock of the what-context panel's context box.

Renders the Claude Code /context visual as a single bordered box with three
labelled sections: Usage (a window grid + a figure line), Composition (a
dot-leader legend), and Response.

Why Python: the box is a faithful mirror of a TUI panel, so layout must be
controlled character-for-character. Bash counts ``${#var}`` in bytes and its
per-character substring loop is locale-fragile, which is what kept misrendering
the glyphs. Python + :mod:`wcwidth` computes true display width, so the grid
and box edges align on any terminal.

Glyphs (Miscellaneous Symbols; each is single-width, verified via wcwidth):

    filled   U+26C1  - one glyph for every used category; colour distinguishes
    free     U+26F6  - square four corners
    buffer   U+26DD  - squared saltire (the auto-compact reserve)

The grid fills in reading order, top-left to bottom-right: the used slices
first, then free space, then the buffer band at the bottom-right. It spans the
full inner width of the box; cells are single-space separated.

Colours come from theme tokens (this file snapshots the built-in opencode
theme, dark mode); the glyph shapes keep categories apart even where the
theme's tokens collapse to one colour. Every percentage is dim. The model
rides the box title.

The grid always depicts the context window. In the no-usage states the
request's rendered-byte shape is scaled to its estimated share of the window
(the sample's 66% estimate by default; SHARE= overrides, 100 renders the
request at full scale as a reference variant); the remainder is free.

States (STATE=): happy, awaiting, orphan, error, title.

Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
Version: 3.4.0
Date: 2026-11-22
License: MIT

Usage:
    STATE=awaiting W=60 ROWS=8 ./context-usage-v3.py

Dependencies:
    wcwidth

Exit codes:
    0 - Rendered
    1 - Unknown state
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from typing import Sequence

import wcwidth

# --- glyphs ---------------------------------------------------------------

GL_FILLED = "\u26c1"  # ⛁  one glyph; colour carries the category
GL_FREE = "\u26f6"  # ⛶
GL_BUFFER = "\u26dd"  # ⛝

# --- palette (truecolour "r,g,b") -----------------------------------------
#
# A snapshot of the built-in opencode theme, dark mode, as resolved from the
# opencode binary's theme document: accent = purple, interactive = orange,
# neutral = gray. In this theme text.muted *is* hue.neutral.400 and
# text.faint defaults back to muted, so the grey family all lands on one
# value; the glyph shapes keep the categories apart where colour cannot.
# Scaffolding takes the categorical hue furthest from the three house hues
# (blue here). The box takes its colours from theme tokens, so another theme
# re-resolves these the same way.

C_BASE = "238,238,238"  # text.base, neutral.200
C_DIM = "128,128,128"  # text.muted / text.faint, neutral.400
C_SYSTEM = "115,87,162"  # hue.accent.400, purple
C_MESSAGES = "182,124,86"  # hue.interactive.400, orange
C_TOOLS = "128,128,128"  # hue.neutral.400, gray
C_SCAFFOLDING = "60,112,184"  # categorical blue.400, furthest from the house hues
C_FREE = "128,128,128"  # text.faint
C_BUFFER = "245,167,66"  # feedback.warning.base
C_UNCLASSIFIED = "128,128,128"  # text.muted
C_ERROR = "224,108,117"  # feedback.error.base, red.200

# --- sample data (one consistent call, in tokens) -------------------------

WINDOW = 200_000
SYSTEM = 12_000
MESSAGES = 90_000
TOOLS = 8_000
SCAFFOLDING = 2_000
PROMPT = SYSTEM + MESSAGES + TOOLS + SCAFFOLDING
BUFFER = 20_000  # compaction.buffer
FREE = WINDOW - PROMPT - BUFFER
CACHE_PCT = 73  # share of the prompt served from cache
RESPONSE = 1_200
REASONING = 300
TITLE_PROMPT = 12_000  # the title-state sample call

# Byte-shares of the request for the no-usage states (sum to 100): the
# rendered-byte proportions of the sample composition, matching the preview.
SYS_B, MSG_B, TOOL_B, SCAFF_B = 11, 80, 7, 2

MODEL = os.environ.get("MODEL", "lmstudio/qwen3.8-27b-splash")
W = int(os.environ.get("W", "60"))  # box outer width
ROWS = int(os.environ.get("ROWS", "8"))
STATE = os.environ.get("STATE", "happy")
# No-usage states: the request's estimated share of the window, in percent.
# The grid always depicts the window: the shape state scales the request
# shape to this share, the rest free. Defaults to the sample's prompt share
# (resolved in main); SHARE= overrides. SHARE=100 renders the request at
# full scale (grid = the request) as a reference variant.
SHAPE_SHARE = os.environ.get("SHARE")
PAD = 1  # inner margin, each side


# --- helpers --------------------------------------------------------------

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def dw(text: str) -> int:
    """Display width of *text*, excluding ANSI SGR sequences.

    Args:
        text: Possibly ANSI-coloured string.

    Returns:
        Columns the text occupies once colour codes are removed.
    """
    return sum(wcwidth.wcwidth(ch) for ch in _ANSI.sub("", text))


def fg(rgb: str, text: str) -> str:
    """Wrap *text* in a truecolour foreground.

    Args:
        rgb: ``"r,g,b"`` triplet.
        text: Content to colour.

    Returns:
        The wrapped, reset-terminated string.
    """
    r, g, b = (int(x) for x in rgb.split(","))
    return f"\x1b[38;2;{r};{g};{b}m{text}\x1b[0m"


def dim(text: str) -> str:
    """Wrap *text* in the theme's dim layer (text.muted / text.faint)."""
    return fg(C_DIM, text)


def fmt_token(n: int) -> str:
    """Compact token count: 11500 -> '11.5k', 2500000 -> '2.5m', 992 -> '992'."""
    if n >= 1_000_000:
        return f"{n // 1_000_000}.{(n % 1_000_000) // 100_000}m"
    if n >= 1_000:
        return f"{n // 1_000}.{(n % 1_000) // 100}k"
    return str(n)


def pct(part: int, whole: int) -> int:
    """Integer percentage of *part* over *whole*, rounded half-up."""
    if whole == 0:
        return 0
    return (part * 100 + whole // 2) // whole


def apportion(values: Sequence[int], total: int) -> list[int]:
    """Split *total* cells proportionally to *values* (largest-remainder).

    Args:
        values: Non-negative magnitudes (token counts or byte-share points).
        total: Number of cells to distribute.

    Returns:
        Integer counts that sum to exactly *total*.
    """
    denom = sum(values)
    if denom == 0 or total == 0:
        return [0] * len(values)
    exact = [v / denom * total for v in values]
    counts = [int(x) for x in exact]
    order = sorted(range(len(values)), key=lambda i: exact[i] - counts[i], reverse=True)
    leftover = total - sum(counts)
    k = 0
    while leftover > 0:
        counts[order[k % len(order)]] += 1
        leftover -= 1
        k += 1
    return counts


@dataclass
class Cell:
    """One grid cell: a glyph and its colour."""

    glyph: str
    color: str


def grid_cells(
    system: int, messages: int, tools: int, scaffolding: int, free: int, buffer: int, total: int
) -> list[Cell]:
    """Build the ordered cell list for a fully-answered call."""
    counts = apportion([system, messages, tools, scaffolding, free, buffer], total)
    pairs = [
        (GL_FILLED, C_SYSTEM),
        (GL_FILLED, C_MESSAGES),
        (GL_FILLED, C_TOOLS),
        (GL_FILLED, C_SCAFFOLDING),
        (GL_FREE, C_FREE),
        (GL_BUFFER, C_BUFFER),
    ]
    cells: list[Cell] = []
    for n, (glyph, color) in zip(counts, pairs):
        cells.extend(Cell(glyph, color) for _ in range(n))
    return cells


def grid_shape_cells(total: int, share: int = 100) -> list[Cell]:
    """Build the cell list for the no-usage states.

    The four slices occupy *share* percent of the window in their rendered-byte
    proportions; the remainder is free. share=100 (default) renders the
    request shape at full scale, so the grid depicts the request, not the
    window. A smaller share scales the shape to its estimated window share.
    """
    share = max(0, min(100, share))
    regions = apportion([share, 100 - share], total)
    counts = apportion([SYS_B, MSG_B, TOOL_B, SCAFF_B], regions[0])
    pairs = [
        (GL_FILLED, C_SYSTEM),
        (GL_FILLED, C_MESSAGES),
        (GL_FILLED, C_TOOLS),
        (GL_FILLED, C_SCAFFOLDING),
    ]
    cells: list[Cell] = []
    for n, (glyph, color) in zip(counts, pairs):
        cells.extend(Cell(glyph, color) for _ in range(n))
    # The remainder of the window is free (shape states: buffer unknown).
    cells.extend(Cell(GL_FREE, C_FREE) for _ in range(regions[1]))
    return cells


def title_cells(total: int) -> list[Cell]:
    """Cell list for the non-primary (title) call: a quiet unclassified band."""
    used = apportion([TITLE_PROMPT, WINDOW - TITLE_PROMPT - BUFFER, BUFFER], total)
    pairs = [
        (GL_FILLED, C_UNCLASSIFIED),
        (GL_FREE, C_FREE),
        (GL_BUFFER, C_BUFFER),
    ]
    cells: list[Cell] = []
    for n, (glyph, color) in zip(used, pairs):
        cells.extend(Cell(glyph, color) for _ in range(n))
    return cells


def render_grid(cells: Sequence[Cell], cols: int, inner: int) -> list[str]:
    """Render *cells* as space-separated rows, each padded to *inner* columns.

    Args:
        cells: Ordered cell list.
        cols: Cells per row.
        inner: Target row width (display columns).

    Returns:
        One string per grid row, left-aligned and padded.
    """
    rows = []
    for r in range(0, len(cells), cols):
        row = cells[r : r + cols]
        # Group consecutive same-colour cells into one run so the spaces
        # between their glyphs fall inside the colour span, exactly as the
        # terminal preview composes it.
        parts: list[str] = []
        i = 0
        while i < len(row):
            j = i
            while j < len(row) and row[j].color == row[i].color:
                j += 1
            parts.append(fg(row[i].color, " ".join(c.glyph for c in row[i:j])))
            i = j
        line = " ".join(parts)
        line += " " * max(0, inner - dw(line))
        rows.append(line)
    return rows


def leader(fill: int) -> str:
    """A run of *fill* middle-dots for a legend leader (dim)."""
    return dim("·" * max(0, fill)) if fill > 0 else ""


def fit_name(name: str, nominal: int, lead: int, after: int, inner: int) -> str:
    """Fit a row's name into the box (mirrors fitName in src/context.ts).

    Padded to *nominal* cells when the box hosts it; elided with a
    single-cell ellipsis when the box cannot host name, leader, and figure
    together. The leader absorbs the difference down to LEADER_MIN, so the
    composed row never exceeds the box's inner width.

    Args:
        name: The full name.
        nominal: The name's nominal width in cells.
        lead: Cells left of the name (glyph plus gap, or tree connector).
        after: Cells right of the leader (figure plus share).
        inner: The box's content width in cells.

    Returns:
        The name, padded or elided, at the width that keeps the row exact.
    """
    w = min(nominal, max(0, inner - lead - after - LEADER_MIN))
    if len(name) <= w:
        return name.ljust(w)
    if w > 1:
        return name[: w - 1] + "…"
    return name[:w]


def _value_span(tokens: str, share: int) -> str:
    """The figure (base colour) and share (dim) of a legend or sub row,
    right-aligned in fixed-width columns, exactly as the preview composes it."""
    fig = "·····" if tokens == "null" else tokens
    return f" {fg(C_BASE, fig.rjust(6))} {dim(f'{share}%'.rjust(5))}"


def legend_row(
    color: str, glyph: str, name: str, tokens: str, share: int, inner: int, name_w: int
) -> str:
    """One legend row: coloured glyph, dim name, dot leader, value."""
    val = _value_span(tokens, share)
    fitted = fit_name(name, name_w, 2, dw(val), inner)  # glyph + gap
    pad = inner - 1 - 1 - dw(fitted) - dw(val)
    return f"{fg(color, glyph)} {fg(C_DIM, fitted)}{leader(int(pad))}{val}"


def sub_row(tree: str, name: str, tokens: str, share: int, inner: int, name_w: int) -> str:
    """One breakdown sub-row: dim tree connector, dim name, dot leader, value."""
    val = _value_span(tokens, share)
    fitted = fit_name(name, name_w, 2, dw(val), inner)  # tree connector
    pad = inner - 2 - dw(fitted) - dw(val)
    return f"{dim(tree)}{fg(C_DIM, fitted)}{leader(int(pad))}{val}"


def box(lines: Sequence[str], title: str) -> str:
    """Wrap content *lines* in a bordered box with a *title*.

    Args:
        lines: Inner content rows (may carry ANSI colour).
        title: Text placed in the top border.

    Returns:
        The rendered box.
    """
    inner = max((dw(l) for l in lines), default=0)
    content = f"─ {title} "
    top = "╭" + content + "─" * max(0, inner + 2 - dw(content)) + "╮"
    out = [top]
    for l in lines:
        out.append(f"│ {l}{' ' * max(0, inner - dw(l))} │")
    out.append(f"╰{'─' * (inner + 2)}╯")
    return "\n".join(out)


# --- sections -------------------------------------------------------------

NAME_W = 12
SUB_W = 19
LEADER_MIN = 1  # a leader keeps at least this many dots before the name yields


def section_happy(inner: int, cols: int) -> list[str]:
    total = cols * ROWS
    cells = grid_cells(SYSTEM, MESSAGES, TOOLS, SCAFFOLDING, FREE, BUFFER, total)
    lines = [fg(C_BASE, "Usage:")]
    lines += render_grid(cells, cols, inner)
    fig = (
        fg(C_BASE, f"{pct(PROMPT, WINDOW)}% used")
        + dim(f" · {fmt_token(PROMPT)}/{fmt_token(WINDOW)}")
        + fg(C_FREE, f" · {fmt_token(FREE)} free")
        + dim(f" · {CACHE_PCT}% cached")
    )
    lines += [fig, ""]
    lines.append(fg(C_BASE, "Composition:"))
    lines.append(legend_row(C_SYSTEM, GL_FILLED, "System", fmt_token(SYSTEM), pct(SYSTEM, WINDOW), inner, NAME_W))
    lines.append(sub_row("├ ", "core/skill-guidance", "5.0k", 42, inner, SUB_W))
    lines.append(sub_row("├ ", "core/instructions", "4.1k", 34, inner, SUB_W))
    lines.append(sub_row("└ ", "core/rules", "2.9k", 24, inner, SUB_W))
    lines.append(legend_row(C_MESSAGES, GL_FILLED, "Messages", fmt_token(MESSAGES), pct(MESSAGES, WINDOW), inner, NAME_W))
    lines.append(sub_row("├ ", "text", "76.2k", 85, inner, SUB_W))
    lines.append(sub_row("├ ", "tool", "11.6k", 13, inner, SUB_W))
    lines.append(sub_row("└ ", "reasoning", "2.2k", 2, inner, SUB_W))
    lines.append(legend_row(C_TOOLS, GL_FILLED, "Tools", fmt_token(TOOLS), pct(TOOLS, WINDOW), inner, NAME_W))
    lines.append(legend_row(C_SCAFFOLDING, GL_FILLED, "Scaffolding", fmt_token(SCAFFOLDING), pct(SCAFFOLDING, WINDOW), inner, NAME_W))
    lines.append(legend_row(C_FREE, GL_FREE, "Free", fmt_token(FREE), pct(FREE, WINDOW), inner, NAME_W))
    lines.append(legend_row(C_BUFFER, GL_BUFFER, "Buffer", fmt_token(BUFFER), pct(BUFFER, WINDOW), inner, NAME_W))
    lines += ["", fg(C_BASE, "Response:")]
    lines.append(
        dim("→ ")
        + fg(C_BASE, fmt_token(RESPONSE))
        + dim(" response")
        + dim(f" ({fmt_token(REASONING)} reasoning)")
    )
    lines += ["", dim("all numbers in tokens")]
    return lines


def section_shape(inner: int, cols: int, status: str, status_color: str, share: int = 100) -> list[str]:
    total = cols * ROWS
    cells = grid_shape_cells(total, share)
    lines = [fg(C_BASE, "Usage:")]
    lines += render_grid(cells, cols, inner)
    if share >= 100:
        note = "shares by rendered bytes"
    else:
        note = f"est. {share}% of window (bytes)"
    lines += [f"{fg(status_color, status)}{dim(f' · {note}')}", ""]
    lines.append(fg(C_BASE, "Composition:"))
    lines.append(legend_row(C_SYSTEM, GL_FILLED, "System", "null", SYS_B, inner, NAME_W))
    lines.append(sub_row("├ ", "core/skill-guidance", "null", 42, inner, SUB_W))
    lines.append(sub_row("├ ", "core/instructions", "null", 34, inner, SUB_W))
    lines.append(sub_row("└ ", "core/rules", "null", 24, inner, SUB_W))
    lines.append(legend_row(C_MESSAGES, GL_FILLED, "Messages", "null", MSG_B, inner, NAME_W))
    lines.append(sub_row("├ ", "text", "null", 85, inner, SUB_W))
    lines.append(sub_row("├ ", "reasoning", "null", 2, inner, SUB_W))
    lines.append(sub_row("└ ", "tool", "null", 13, inner, SUB_W))
    lines.append(legend_row(C_TOOLS, GL_FILLED, "Tools", "null", TOOL_B, inner, NAME_W))
    lines.append(legend_row(C_SCAFFOLDING, GL_FILLED, "Scaffolding", "null", SCAFF_B, inner, NAME_W))
    lines += ["", fg(C_BASE, "Response:")]
    lines.append(f"{dim('→ ')}{fg(status_color, status)}")
    return lines


def section_title(inner: int, cols: int) -> list[str]:
    total = cols * ROWS
    cells = title_cells(total)
    lines = [fg(C_BASE, "Usage:")]
    lines += render_grid(cells, cols, inner)
    lines += [
        fg(C_BASE, f"{pct(TITLE_PROMPT, WINDOW)}% used")
        + dim(f" · {fmt_token(TITLE_PROMPT)}/{fmt_token(WINDOW)}"),
        "",
    ]
    lines.append(fg(C_BASE, "Composition:"))
    lines.append(dim("no composition captured"))
    lines += ["", fg(C_BASE, "Response:")]
    lines.append(f"{dim('→ ')}{fg(C_BASE, fmt_token(61))}{dim(' response')}")
    lines += ["", dim("all numbers in tokens")]
    return lines


def main() -> int:
    inner = W - 2 - 2 * PAD
    # A grid row is 2*cols-1 cells; this keeps it at or under the inner width
    # at every box width (mirrors src/context.ts).
    cols = max(1, (inner + 1) // 2)
    # The in-flight sample request (118k body against the 100k baseline call)
    # estimates to 66% of the window, matching the preview's sample records.
    share = int(SHAPE_SHARE) if SHAPE_SHARE else 66

    if STATE == "happy":
        lines = section_happy(inner, cols)
    elif STATE in ("awaiting", "orphan", "error"):
        status, color = {
            "awaiting": ("no usage yet", C_DIM),
            "orphan": ("no response received", C_BUFFER),
            "error": ("provider error 500", C_ERROR),
        }[STATE]
        lines = section_shape(inner, cols, status, color, share)
    elif STATE == "title":
        lines = section_title(inner, cols)
    else:
        print(f"unknown state: {STATE} (happy|awaiting|orphan|error|title)", file=sys.stderr)
        return 1

    print(box(lines, f"Context · {MODEL}"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
