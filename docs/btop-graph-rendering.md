# btop graph rendering, reverse engineered

Reference analysis of how [btop](https://github.com/aristocratos/btop) draws its graphs,
meters, boxes, and colors. Prepared for the `opencode-what-context` side-panel polish: this
document is the ground truth for doing the equivalent in this project's OpenCode TUI.

Source: btop `master` at commit `5d03929` (2026-11-11), Apache-2.0. The glyph tables,
formulas, and escape sequences below are quoted from `src/btop_draw.cpp`,
`src/btop_theme.cpp`, `src/btop_config.cpp`, `src/btop_tools.hpp`, and `themes/`.
The core algorithm was verified by a faithful Python re-implementation (cloned btop in
`/private/var/folders/.../opencode/btop-analysis`, `verify_graph.py`), which reproduces
btop's rendered output for constant, ramp, step, and sine curves across all three symbol
sets.

## 1. The rendering stack

btop is a raw-ANSI TUI. There is no widget tree and no diff: each box has a `draw()`
function that returns a string of escape sequences, and the main loop writes it directly
to the terminal using absolute cursor addressing. Two drawing modes exist:

- **Redraw** — the box is torn down and rebuilt (`createBox` redraws the frame, every
  graph is re-constructed from its full data window). Triggered on resize, config
  change, or interface/model change.
- **Incremental** — steady state. Each graph pops its oldest character and appends the new
  one; the meter repaints only when its value changed; static text is skipped.

For this project only the **pure function** (data window → glyph rows) is portable. The
incremental cursor machinery exists because btop writes ANSI by hand; the OpenCode TUI
(`@opentui`, Solid reactive) diff-renders declaratively, so the panel re-renders the whole
graph text on each new record — a few hundred table lookups, negligible.

## 2. Data model

Graphs consume a `std::deque<long long>` of integers in `0..100` (percent), one sample per
collection cycle, oldest first:

- Percent-sourced data (CPU, memory, GPU): the collectors push `0..100` directly.
- Arbitrary-scale data (temperatures, network bandwidth, process CPU) are passed with
  `max_value`/`offset` and normalized inside the graph:
  `v = clamp((v + offset) * 100 / max_value, 0, 100)` (integer arithmetic).
  Examples: temperature graphs use `max_value = temp_max, offset = -23` (so 0 °C maps to
  the floor); the GPU VRAM-utilization graph uses `offset = 4` so 0–5 % still shows a
  trace; the net graphs use a dynamically rescaled `max_value` (section 8).
- Window size: collectors trim the deque to the graph's sample capacity. For braille,
  one cell holds two samples, so the net collector trims to `width * 2` samples; for tty
  (one sample per cell) to `width`.

## 3. The `Draw::Graph` class

Constructor: `Graph(width, height, color_gradient, data, symbol, invert, no_zero,
max_value, offset)`.

**Symbol resolution.** `symbol` is one of `"default"`, `"braille"`, `"block"`, `"tty"`
(per-box config `graph_symbol_cpu` etc. fall back to the global `graph_symbol`, default
`"braille"`). `"default"` resolves to the global config. Global `tty_mode` forces `"tty"`
for every graph.

**Windowing.** The constructor computes how many samples fit:

```cpp
const int value_width = (tty_mode ? data.size() : ceil((double)data.size() / 2));
int data_offset = (value_width > width) ? data.size() - width * (tty_mode ? 1 : 2) : 0;
if (not tty_mode and (data.size() - data_offset) % 2 != 0) data_offset--;
```

- Braille/block: a cell encodes **two** samples, so `width` cells hold `width * 2`
  samples; the offset keeps the newest `2 * width` samples.
- Tty: one sample per cell; keep the newest `width`.
- The `%- 2 != 0` adjustment drops one extra oldest sample in non-tty mode so sample
  pairs always start on a cell boundary (the leftmost cell is a complete pair).
- If fewer samples than cells, the left side is padded with blanks (braille/block) or a
  single `Mv::r(1)` cursor-move per empty cell (tty, height 1).

**The two switching buffers.** The graph keeps two row buffers, `graphs[true]` and
`graphs[false]`, and a `current` flag. Each new sample inverts `current` (non-tty mode
only; tty uses one buffer), so successive samples write to alternating buffers. In
braille this is the doubling mechanism: the glyph appended for sample *i* encodes
samples (*i−1, i*), and the next sample's glyph re-encodes sample *i* as its "previous"
half. A full-width graph therefore displays `2 * width` samples continuously.

### 3.1 `_create` — the core loop

```cpp
void Graph::_create(const deque<long long>& data, int data_offset) {
    bool mult = (data.size() - data_offset > 1);                 // more than one sample?
    const auto& graph_symbol = Symbols::graph_symbols.at(symbol + '_' + (invert ? "down" : "up"));
    array<int, 2> result;
    const float mod = (height == 1) ? 0.3 : 0.1;                 // rounding bias, below
    long long data_value = 0;
    if (mult and data_offset > 0) {                              // seed `last` from the
        last = data.at(data_offset - 1);                         // sample just outside
        if (max_value > 0) last = clamp((last + offset) * 100 / max_value, 0ll, 100ll);
    }                                                            // the window

    //? Horizontal iteration over values in <data>
    for (const int& i : iota(data_offset, (int)data.size())) {
        if (not tty_mode and mult) current = not current;
        data_value = data.at(i);
        if (max_value > 0) data_value = clamp((data_value + offset) * 100 / max_value, 0ll, 100ll);

        //? Vertical iteration over height of graph
        for (const int& horizon : iota(0, height)) {
            const int cur_high = (height > 1) ? round(100.0 * (height - horizon) / height) : 100;
            const int cur_low  = (height > 1) ? round(100.0 * (height - (horizon + 1)) / height) : 0;
            //? Calculate previous + current value to fit two values in 1 braille character
            for (int ai = 0; const auto& value : {last, data_value}) {
                const int clamp_min = (no_zero and horizon == height - 1
                    and not (mult and i == data_offset and ai == 0)) ? 1 : 0;
                if (value >= cur_high)
                    result[ai++] = 4;
                else if (value <= cur_low)
                    result[ai++] = clamp_min;
                else
                    result[ai++] = clamp((int)round((float)(value - cur_low) * 4 / (cur_high - cur_low) + mod),
                                         clamp_min, 4);
            }
            if (height == 1) {
                if (result.at(0) + result.at(1) == 0) graphs.at(current).at(horizon) += Mv::r(1);
                else {
                    if (not color_gradient.empty())
                        graphs.at(current).at(horizon) += Theme::g(color_gradient).at(clamp(max(last, data_value), 0ll, 100ll));
                    graphs.at(current).at(horizon) += graph_symbol.at((result.at(0) * 5 + result.at(1)));
                }
            }
            else graphs.at(current).at(horizon) += graph_symbol.at((result.at(0) * 5 + result.at(1)));
        }
        if (mult and i >= 0) last = data_value;
    }
    //? Assemble: row 0 of the buffer is the TOP of the graph; one color per row
    if (height == 1) {
        out = graphs.at(current).at(0);
    } else {
        for (const int& i : iota(1, height + 1)) {
            if (i > 1) out += Mv::d(1) + Mv::l(width);
            if (not color_gradient.empty())
                out += (invert) ? Theme::g(color_gradient).at(i * 100 / height)
                                : Theme::g(color_gradient).at(100 - ((i - 1) * 100 / height));
            out += (invert) ? graphs.at(current).at(height - i) : graphs.at(current).at(i - 1);
        }
    }
    if (not color_gradient.empty()) out += Fx::reset;
}
```

The mechanics, step by step:

1. **Bands.** The graph's `height` text rows split the 0–100 range into `height` bands.
   Row `horizon` (0 = top) covers `[cur_low, cur_high]` where `cur_high = round(100 *
   (height − horizon) / height)` and `cur_low = round(100 * (height − horizon − 1) /
   height)`; a one-row graph is the single band `[0, 100]`.
2. **Levels.** For each of the two samples, the level within the current band is
   quantized to `0..4`: 4 = at or above the band's top, 0 = at or below its bottom,
   otherwise `round((v − cur_low) * 4 / (cur_high − cur_low) + mod)`. The `mod` bias
   (0.1, or 0.3 for one-row graphs) added before `round` pushes half-band values
   *up*, which closes the hairline gaps that would otherwise open between stacked rows.
3. **Glyph.** `glyph = table[level_last * 5 + level_current]` — a 5×5 lookup, row =
   the *previous* sample's level, column = the *current* sample's level (section 4).
4. **`no_zero`.** In the bottom row, a value at or below the band's floor is clamped to
   level 1 instead of 0, so 0 % reads as a one-dot trace along the floor rather than
   empty space (the CPU graphs use it; the one exception is the very first sample of a
   freshly trimmed window, which may stay blank).
5. **Assembly and color.** Buffer row 0 is emitted as the top text row. Each row gets a
   single foreground color from the named gradient, indexed by **row position**, not by
   value: top row = `gradient[100]`, bottom row = `gradient[0]` (integer math, `100 −
   (i−1) * 100 / height`). Because row position *is* the value band, this colors the
   curve by magnitude: hot at the top, cold at the floor. For `invert` graphs the row
   order and the gradient direction are both flipped (section 3.3). One-row graphs
   instead color **per cell** with `gradient[clamp(max(last, data_value))]`, since the
   row carries no value information of its own.
6. **`Fx::reset`** terminates the graph so the next box's text is not tinted.

### 3.2 Incremental update

`Graph::operator()(data, data_same)`: if `data_same` the cached output is returned.
Otherwise it flips `current` to the other buffer, erases the leftmost character of each
row (carefully: a 1-byte space, a 3-byte UTF-8 glyph, or a leading color escape plus the
glyph it colored), and runs `_create` with `data_offset = data.size() − 1` — i.e. only
the newest sample. The net effect: the graph scrolls left by one cell per sample,
redrawn in place with `Mv` cursor moves, no full repaint.

### 3.3 `invert`

For graphs that hang from the top (btop's lower CPU/GPU graphs, anchored to the box's
mid-line). It changes exactly three things: the `_down` symbol table (section 4), the
emitted row order (buffer row `height − i`), and the gradient index (`i * 100 / height`
instead of its complement). The band math is unchanged: level still means "how far into
the band from the bottom", and the `_down` tables make that fill *downward* inside the
cell, so a value near zero hugs the top edge of an inverted graph.

## 4. The symbol tables

`Symbols::graph_symbols` holds six 5×5 lookup tables: `{braille, block, tty} × {up,
down}`. Index is `[level_of_previous * 5 + level_of_current]`; row 0/col 0 is the blank.
Verbatim from source (code points given; braille glyphs are U+28xx):

```text
braille_up (level a of previous, level b of current):
    b→   0      1      2      3      4
a=0  sp    U+2880 U+28A0 U+28B0 U+28B8
a=1  U+2840 U+28C0 U+28E0 U+28F0 U+28F8
a=2  U+2844 U+28C4 U+28E4 U+28F4 U+28FC
a=3  U+2846 U+28C6 U+28E6 U+28F6 U+28FE
a=4  U+2847 U+28C7 U+28E7 U+28F7 U+28FF

braille_down:
    b→   0      1      2      3      4
a=0  sp    U+2808 U+2818 U+2838 U+28B8
a=1  U+2801 U+2809 U+2819 U+2839 U+28B9
a=2  U+2803 U+280B U+281B U+283B U+28BB
a=3  U+2807 U+280F U+281F U+283F U+28BF
a=4  U+2847 U+284F U+285F U+287F U+28FF
```

```text
block_up (U+2580 block elements; quadrants TL TR / BL BR of one cell):
    b→   sp     U+2597 U+2597 U+2590 U+2590
a=1  U+2596 U+2584 U+2584 U+259F U+259F
a=2  U+2596 U+2584 U+2584 U+259F U+259F
a=3  U+258C U+2599 U+2599 U+2588 U+2588
a=4  U+258C U+2599 U+2599 U+2588 U+2588

block_down:
    b→   sp     U+259D U+259D U+2590 U+2590
a=1  U+2598 U+2580 U+2580 U+259C U+259C
a=2  U+2598 U+2580 U+2580 U+259C U+259C
a=3  U+258C U+259B U+259B U+2588 U+2588
a=4  U+258C U+259B U+259B U+2588 U+2588
```

```text
tty_up == tty_down (one sample per cell; ░ = 25%, ▒ = 50%, █ = 100%):
    b→   sp     ░      ░      ▒      ▒
a=1  ░      ░      ▒      ▒      █
a=2  ░      ▒      ▒      ▒      █
a=3  ▒      ▒      ▒      █      █
a=4  ▒      █      █      █      █
```

### 4.1 Braille: two values, one cell, eight dots

A braille character is a 2×4 dot matrix. The tables decompose exactly as
`glyph = A_dots(a) ∪ B_dots(b)` — verified against all 25 entries — where each sample
lights `level` dots along its own four-dot serpentine path, and the two paths use
**disjoint dots that together cover all eight**:

- **Sample A = the previous sample** (table row). Dots, in level order:
  level 1 = bottom-right, level 2 = + top-right, level 3 = + mid-left, level 4 = +
  top-left.
- **Sample B = the current sample** (table column). Dots, in level order:
  level 1 = bottom-left, level 2 = + mid-right, level 3 = + mid-left, level 4 = +
  top-mid-right.

```text
braille_up, dot ownership (A = previous, B = current):
     col L   col R
r1  A (L1)  A (R1)
r2  A (L2)  B (R2)
r3  B (L3)  B (R3)
r4  B (L4)  A (R4)
```

Consequences (all verified by rendering):

- The lit dot count of a cell is exactly `a + b` (each level of each sample contributes
  one dot; max 8 at (4,4)). The two "fronts" weave, so a constant series renders as a
  flat filled line and a smooth curve as a continuous filled area — the classic btop
  look — at **two samples per cell**, twice the horizontal resolution of block/tty.
- The diagonal (a = b) forms a ring that closes into the full block ⣿ as the level
  reaches 4; equal values therefore read as a solid band.
- `braille_down` is **not** a geometric mirror: it is the same eight dots in the same
  serpentine positions, with the growth order re-mapped so that level 1 sits at the
  *top* of the cell (the `_up` paths begin at the bottom rows, the `_down` paths at
  the top). The hand-tuned ordering keeps the curve visually continuous in either
  orientation; the two tables differ in exactly which dots the paths add first and
  last.
- Braille glyphs are the highest resolution but the least universally supported
  (config help text); block and tty are the fallbacks.

### 4.2 Block: quadrant pairs, half the resolution

The cell is 2×2 quadrants; levels alias in pairs (1–2 and 3–4) and each sample owns one
column: **A = left column** (levels 1–2 = bottom-left quadrant, 3–4 = full left half),
**B = right column** (bottom-right / full right half); glyph = union. Sample pairs are
therefore clean left-to-right chronology, but vertical resolution is two steps per cell
instead of four — the config help's "half the resolution of braille". `block_down` is
the vertical mirror (top-left / top-right anchoring).

### 4.3 Tty: the ASCII-unsafe fallback

One cell per sample (no pair packing; `tty_mode` disables the buffer alternation). The
glyph is a shade of the `░ ▒ █` ramp chosen from the **sum** of the two levels — sum ≤ 2
→ ░, 3–4 → ▒, ≥ 5 → █ — i.e. the average intensity of the adjacent pair, quantized to
three steps. Used when the terminal cannot do UTF-8 (`tty_mode`), which also swaps the
frame and banner to a 16-color ANSI theme.

### 4.4 Frame, title, and utility glyphs

From `Symbols` (all UTF-8 box drawing):

```text
frame:    ─  │  ┌ ┐ └ ┘        rounded: ╭ ╮ ╰ ╯        divider: ├ ┤ ┬ ┴   dotted: ╎
title:    ┐ (title_left)  ┌ (title_right)   — title tab notches, below
meter:    ■               graph background: index 6 of the active _up table (⣀ / ▄ / ░)
arrows:   ↑ ↓ ← →  ↵      superscripts: ⁰ ¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹
```

`Draw::createBox` draws the frame with absolute cursor moves (`Mv::to`): two horizontal
runs, one vertical run per middle row, four corners (square `┌┐└┘` or rounded `╭╮╰╯` per
the `rounded_corners` config), then the title: positioned two columns in from the left
corner as `┐ TITLE ┌` — the title characters are the corners rotated 90°, which makes
the title read as a tab punched into the top border. The title is bold; an optional box
number renders as a superscript digit in `hi_fg` before the title text; an optional
second title sits on the bottom border the same way (`┘ TITLE └`).

## 5. Color and themes

### 5.1 Theme tokens

A theme is a flat map of named tokens (`.theme` file: `theme[name]="#RRGGBB"` or `"#WW"`
or `"R G B"`; only names present in the built-in `Default_theme` whitelist are accepted;
`#` lines are comments). The structural tokens:

```text
main_bg / main_fg / title / hi_fg / selected_bg / selected_fg / inactive_fg
graph_text        — text drawn on top of graphs (uptime, scale labels)
meter_bg          — the unfilled part of a meter (falls back to inactive_fg)
div_line          — box dividers; box frames: cpu_box, mem_box, net_box, proc_box
proc_*            — process-box accents (banner bg/fg, pause/follow highlights)
<name>_start _mid _end  — gradient stops: temp, cpu, free, cached, available, used,
                          download, upload, process   (13 gradient names)
```

The built-in default palette (24-bit hex): `main_fg #cc`, `title #ee`, `inactive_fg #40`,
`hi_fg #b54040`, `graph_text #60`, `div_line #30`, `cpu_box #556d59`, `mem_box #6c6c4b`,
`net_box #5c588d`, `proc_box #805252`, and the classic three-stop CPU gradient
`#77ca9b → #cbc06c → #dc4c4c` (green → yellow → red); temperature
`#4897d4 → #5474e8 → #ff40b6` (blue → indigo → pink); the "used" gradient runs
dark-red → red. Every bundled theme (`themes/*.theme`, ~40 of them) supplies exactly
these tokens.

### 5.2 Gradient generation

`Theme::generateGradients()` turns each `{name}_start/_mid/_end` RGB triple into a
**101-entry array of ANSI color strings** (index 0–100): integer linear interpolation
from `start` to `end` over 100 steps, or `start → mid → end` as two 50-step passes when
a mid stop exists. A missing `_end` yields a flat 101× `start`. Colors are emitted as
24-bit `38;2;r;g;b` SGR, downgraded to the 256 palette when `lowcolor` is set
(truecolor → 256: shared-channel values map to the 232–255 grey ramp, otherwise the
6×6×6 cube, `r/51*36 + g/51*6 + b/51 + 16`), and to the 16-color `TTY_theme` in
`tty_mode`. `Theme::g(name)` returns the 101-string array; `Theme::c(name)` returns a
single token's SGR string.

### 5.3 How colors attach to graphs

- **Multi-row graphs:** one color per row, by row position → by value band (section 3.1):
  the top of the graph carries the gradient's `end` color, the floor its `start` color.
  The curve thus shifts hue as it rises — the "heat" of the CPU gradient.
- **One-row graphs** (per-core mini graphs, temperature graphs): one color per cell,
  indexed by the max of the cell's two values.
- **Meters** (section 6) color per cell the same way.
- A gradient name of `""` means monochrome: no SGR is emitted and the glyphs inherit
  the surrounding color (the greyscale themes and `proc` greyscale gradient rely on this).

## 6. The `Draw::Meter` class

A horizontal bar of `■` (U+25A0), one per cell, width `width`, value 0–100 (clamped).
For cell `i` of `width`, `y = round(i * 100 / width)`; cells with `value >= y` get
`■` in `gradient[invert ? 100 − y : y]` — so a meter's fill is painted left-to-right
from the gradient's `start` toward its `end` (hotter as it fills), mirroring the graph
row coloring. The first unfilled cell emits the remainder as one run in `meter_bg`. The
result string is cached per value in a `101`-slot array, so repeated values cost nothing.

## 7. Escape-sequence plumbing

`Fx` — SGR: `e` = ESC `[`; bold `1/22`, dim `2/22`, italic `3/23`, underline `4/24`,
blink `5/25`, strike `9/29`; `reset` = `0` + theme fg/bg restore. `Mv` — cursor: `to(l,
c)` = `ESC[l;c f`, plus relative `r/l/u/d` = `nC/D/A/B`. All drawing composes these
prefixes into plain strings; `unescape`/regex helpers strip them where plain text is
needed (mouse hit-testing, width measurement).

## 8. How the boxes use it

- **CPU:** main graph(s) in the left region, `cpu` gradient. `cpu_single_graph` off →
  two stacked graphs (upper + lower, the lower optionally `invert`ed to hang from the
  mid-line, `cpu_invert_lower`), split around a mid-line carrying the two field names
  and a `▲▼`. Core mini-graphs: one per core, `width = 5 * core_columns`, height 1,
  `cpu` gradient, no zero-clamp; a faint `graph_bg`-painted backdrop row is drawn
  behind each. Temperature mini-graphs: width 5, height 1, `temp` gradient,
  `max_value = temp_max, offset = −23`. Load average, clock, and the `CPU` meter row
  live in the right region; the title border carries menu/preset/update-rate buttons.
- **GPU:** per-GPU boxes, `cpu`-named gradient (a `"gpu"` gradient is referenced but
  defaults to the `cpu` one), mirrored upper/lower graphs (`gpu_mirror_graph`), meters
  for utilization/encode/decode, VRAM used + utilization graphs (height 2–4, `used` /
  `free` gradients, `offset = 4` on utilization).
- **Net:** download (top) and upload (bottom) graphs, `download`/`upload` gradients
  (purple families in the default theme), `no_zero` on. **Auto-scale** (`net_auto`,
  default on): the collector tracks `graph_max[dir]`; a sample above the max bumps an
  "up" counter, a sample below `max/10` (10 KiB/s floor) bumps a "down" counter; when
  either reaches 5 consecutive cycles it rescales to `max(1.3 × avg(last 5), 10 KiB/s)`
  on the way up, `max(3.0 × avg(last 5), 10 KiB/s)` on the way down, and forces a full
  redraw. The asymmetric headroom (1.3× vs 3×) keeps the curve ~75 % tall after a spike
  and ~33 % tall after a lull. `net_sync` mirrors the rescale across directions.
  Manual mode uses fixed `net_download`/`net_upload` Miбит values.
- **Proc:** the per-process mini CPU graph (height 1, `process` green→yellow→red
  gradient) scrolls like any other; the detail pane has larger CPU/mem graphs.

## 9. Config knobs (menu)

| Key | Meaning |
| --- | --- |
| `graph_symbol` | Default glyph set: `braille` (default) / `block` / `tty` |
| `graph_symbol_{cpu,gpu,mem,net,proc}` | Per-box override, or `default` |
| `cpu_single_graph` / `cpu_invert_lower` | One graph vs stacked; hang the lower one |
| `cpu_graph_upper` / `cpu_graph_lower` | Which metric each stacked half plots |
| `net_auto` / `net_sync` / `net_download` / `net_upload` | Auto-scale, sync, fixed scales |
| `rounded_corners` | `╭╮╰╯` vs `┌┐└┘` frames |
| `tty_mode` | 16-color ASCII mode: tty graphs, 16-color theme, non-UTF-8 banner |
| `lowcolor` | 256-color output (24-bit otherwise) |
| `theme_background` | Fill `main_bg` vs transparent |
| `color_theme` | One of `themes/*.theme` |

Presets are strings like `"cpu:0:braille,net:0:tty"` — per-box symbol choices that
persist as named layouts.

## 10. Applying this to opencode-what-context

Current panel (`src/tui.tsx`), in btop terms: three `createBox`-style rounded frames with
border-carried titles; a `Meter`-style window-fill gauge (`▇▇▇▇░░` + `!` overrun); a
stacked-bar composition meter; a **one-cell-per-request** trend strip (`▁▂▃▄▅▆▇█`
heights, `^`/`~` marker row); and a request list with per-row mini meters. The btop-style
box language is already done; the piece that is *not* yet the btop equivalent is the
**trend** — a 1-D strip where btop would draw a 2-D graph.

### 10.1 The trend as a braille graph

Map the btop CPU graph onto the session:

| btop | what-context |
| --- | --- |
| sample = one collection cycle | sample = one captured request (`CallView`) |
| value = CPU % | value = `prompt / window * 100` (the existing `fill()`) |
| `max_value` fixed at 100 | the model's registered `limit.context` — the scale is *known*, no net-style auto-scaling needed |
| graph height ≈ 15 rows in a full box | 3–5 rows (the panel is narrow and shared with two other boxes) |
| `cpu` gradient | value-keyed theme gradient (10.3) |
| `no_zero` | records with no usage → 0, but keep a floor dot so idle calls are visible |
| compaction = visible drop | free: a compaction record is a natural cliff in the curve — a feature |

A 4-row braille graph at `width` cells holds `2 * width` requests at 1/16 vertical
granularity; a 3-row block graph holds the same history at 1/6. Either fits the current
trend box's width; the braille version matches the panel's existing block-glyph language
(`█▓▒░`, `▁▂▃▄▅▆▇█`) more closely.

**Marker alignment is the one non-obvious consequence.** A braille cell covers request
pair *(2i, 2i+1)* — the previous sample in the cell's first path, the current in the
second (braille weaves both across the whole cell; block splits left/right). The
existing marker row (`^` for the selected request, `~` for compactions) is
one-cell-per-request and cannot address sub-cell positions, so the marker row should
either (a) keep its 1:1 strip beneath the graph (a second line, aligned so a marker
falls in the cell containing the request — off by at most one request), or (b) render
at double width using narrow sub-cell markers. Option (a) keeps the current two-line
shape and is the safe first step.

### 10.2 Color, within the house rules

The panel's stated design rule (`tui.tsx` header): information rides on channels that
survive any theme — luminance steps, glyph shape, bold — with the house hues as
decoration, because a monochrome terminal collapses every hue token to one grey.

btop's row-by-row gradient is exactly such a decoration: on a monochrome terminal the
rows collapse to one grey, but the **braille shape** (dot count = `a + b`, the filled
area) still carries the whole curve, and `text.base/muted/faint` luminance steps can be
substituted for the hue gradient as the row coloring. Concretely, build the 101-entry
gradient the same way btop does (100-step integer lerp between stops) from theme
tokens — e.g. `hue.accent[400]` → `hue.interactive[500]` → `text.feedback.warning.base`
→ `text.feedback.error.base` at 100, reusing the existing `gaugeColor()` breakpoints —
and apply it per row (position = value). OpenCode themes are generated from the
terminal palette, so the same token-to-gradient recipe survives both colored and
monochrome terminals: hue where available, shape always.

### 10.3 Reference implementation

The core is the pure function below (faithful port of `Draw::Graph::_create`, minus the
ANSI cursor machinery, which `@opentui` diff-rendering replaces). Tables verbatim from
section 4:

```ts
// Two values, one cell: [level of previous * 5 + level of current], each 0-4.
const BRaille_UP = [
  " ", "⢀", "⢠", "⢰", "⢸",
  "⡀", "⣀", "⣠", "⣰", "⣸",
  "⡄", "⣄", "⣤", "⣴", "⣼",
  "⡆", "⣆", "⣦", "⣶", "⣾",
  "⡇", "⣇", "⣧", "⣷", "⣿",
]
const BRaille_DOWN = [
  " ", "⠈", "⠘", "⠸", "⢸",
  "⠁", "⠉", "⠙", "⠹", "⢹",
  "⠃", "⠋", "⠛", "⠻", "⢻",
  "⠇", "⠏", "⠟", "⠿", "⢿",
  "⡇", "⡏", "⡟", "⡿", "⣿",
]
const BLOCK_UP = [
  " ", "▗", "▗", "▐", "▐",
  "▖", "▄", "▄", "▟", "▟",
  "▖", "▄", "▄", "▟", "▟",
  "▌", "▙", "▙", "█", "█",
  "▌", "▙", "▙", "█", "█",
]
// BLOCK_DOWN / TTY_UP / TTY_DOWN likewise (section 4); tty_up === tty_down.

interface GraphOptions {
  width: number
  height: number
  symbol?: "braille" | "block" | "tty"
  invert?: boolean
  noZero?: boolean
  maxValue?: number // scale with (v + offset) * 100 / maxValue
  offset?: number
}

function renderGraph(data: readonly number[], opts: GraphOptions): string[] {
  // 1. window: keep newest 2*width (braille/block) or width (tty) samples,
  //    then drop one more if the pair count is odd
  // 2. for each sample: level within each of the height bands,
  //    round((v - low) * 4 / (high - low) + (height === 1 ? 0.3 : 0.1)), clamped
  // 3. glyph = table[levelPrev * 5 + levelCur]; no_zero floors level 1 on the
  //    bottom band
  // 4. emit height rows, top first; invert flips row order and table
  // returns plain strings; the caller applies per-row color spans
}
```

(Copy the tables from the cloned source — `Symbols::graph_symbols` in
`src/btop_draw.cpp` of the analysis clone — rather than retyping them; the verified
re-implementation lives in `verify_graph.py` alongside the clone in the session temp
directory, and renders constant/ramp/step/sine curves identically to btop.)

Integration notes:

- Feed the graph the session's `fill()` values, oldest first, clamped to 0–100;
  over-100 prompts clamp to 100 (the overrun is already surfaced by the gauge and the
  list — the graph has no headroom above its top row, and btop clamps too).
- The graph re-renders as a whole on each `recorded` event (the existing refetch path);
  no incremental cursor code is needed, and the row strings can be colored with one
  span per row using the 10.2 gradient.
- The trend box's title already carries the scale label (`128k window · 40/212`), which
  is exactly btop's convention (scale at the frame edge, `graph_text`-colored); keep it.
- Height should be adaptive: 3–5 rows when docked, more when the panel is fullscreen,
  matching how btop sizes graphs to box geometry.

### 10.4 Open decisions for the polish session

- Braille vs block for the trend (braille = current glyph language + 2× resolution;
  block = safer font coverage, cleaner pair chronology).
- Marker-row strategy 10.1(a)/(b).
- Whether the header gauge and list mini-gauges also move to the meter gradient
  (per-cell `■` lerp) or keep the current `▇/░` binary shape.
- Graph height per presentation (docked vs fullscreen).
