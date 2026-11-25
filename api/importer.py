"""Turn an uploaded Excel / CSV file into question rows, and build the blank template.

Column names are matched loosely ("Question" or "Clue", "Answer" or "Response", "Points" or "Value"...),
so the file the question writers already have usually loads without edits.
"""

from __future__ import annotations

import csv
import io
import re
from typing import Any

MAX_ROWS = 2000

# Canonical column -> accepted header spellings (compared after lower-casing and dropping punctuation).
_ALIASES: dict[str, set[str]] = {
    "game_id": {"game", "gameid", "set", "board", "questionset", "gamename"},
    "round": {"round", "roundname", "stage", "roundnumber"},
    "category": {"category", "categories", "cat", "topic", "categoryname"},
    "value": {"value", "points", "pointvalue", "dollar", "dollars", "amount", "dollarvalue", "pts"},
    "clue": {"clue", "question", "prompt", "questiontext", "cluetext"},
    "answer": {"answer", "response", "correctanswer", "correctresponse", "solution"},
    "daily_double": {"dailydouble", "dd", "isdailydouble"},
    "media": {
        "media", "mediafile", "medianame", "mediaurl", "medialink", "image", "imagefile", "imageurl", "picture",
        "video", "videofile", "videourl", "videolink", "audio", "file", "filename", "attachment", "url", "link",
    },
    "answer_media": {
        "answermedia", "answerimage", "answerpicture", "answervideo", "answerfile", "answermediafile",
        "responsemedia", "responseimage", "responsepicture", "revealmedia", "revealimage",
    },
}
_REQUIRED = ("category", "clue", "answer")
_TRUE = {"y", "yes", "true", "t", "1", "x", "dd", "dailydouble", "daily double"}

TEMPLATE_HEADERS = ["game_id", "round", "category", "value", "clue", "answer", "daily_double"]
_NO_HEADER_PREFIX = 'Skipped sheet "'


class ImportProblem(ValueError):
    """The file cannot be turned into a usable question set."""


def _norm(header: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(header or "").lower())


def _column_map(header_row: list[Any]) -> dict[str, int]:
    found: dict[str, int] = {}
    for idx, cell in enumerate(header_row):
        key = _norm(cell)
        if not key:
            continue
        for canonical, names in _ALIASES.items():
            if key in names and canonical not in found:
                found[canonical] = idx
    return found


def parse_round(raw: Any) -> str | None:
    """'1', '2' or 'final'; None when the text says nothing about the round."""
    text = str(raw or "").strip().lower()
    if not text:
        return None
    if "final" in text or text in {"fj", "f"}:
        return "final"
    if "double" in text or text in {"dj", "2", "2.0"}:
        return "2"
    if "jeopardy" in text or "single" in text or text in {"j", "1", "1.0"}:
        return "1"
    match = re.search(r"\d+", text)
    if match:
        return str(int(match.group()))
    return None


def sheet_round(name: Any) -> str | None:
    """Round implied by a sheet or file name. Only explicit wording counts, so "Sheet1" or
    "q3_2026.csv" say nothing about the round."""
    text = str(name or "").strip().lower()
    if "final" in text:
        return "final"
    if "double" in text:
        return "2"
    if "jeopardy" in text or "single" in text:
        return "1"
    match = re.search(r"\bround[\s_-]*(\d+)\b", text)
    return str(int(match.group(1))) if match else None


def parse_value(raw: Any) -> int | None:
    if raw is None or str(raw).strip() == "":
        return None
    cleaned = re.sub(r"[^0-9.\-]", "", str(raw))
    if not cleaned:
        return None
    try:
        return int(round(float(cleaned)))
    except ValueError:
        return None


def _is_true(raw: Any) -> bool:
    return str(raw or "").strip().lower() in _TRUE


def _clean(raw: Any) -> str:
    return re.sub(r"\s+", " ", str(raw if raw is not None else "")).strip()


def _rows_from_table(
    table: list[list[Any]], sheet: str, default_game: str, warnings: list[str]
) -> list[dict[str, Any]]:
    header_at = None
    cols: dict[str, int] = {}
    for idx, row in enumerate(table[:15]):
        cols = _column_map(list(row))
        if all(name in cols for name in _REQUIRED):
            header_at = idx
            break
    if header_at is None:
        warnings.append(
            f'{_NO_HEADER_PREFIX}{sheet}": no header row with Category, Question/Clue and Answer columns.'
        )
        return []

    implied_round = sheet_round(sheet)
    last_category: dict[str, str] = {}
    out: list[dict[str, Any]] = []
    for offset, row in enumerate(table[header_at + 1 :], start=header_at + 2):
        def cell(name: str) -> Any:
            idx = cols.get(name)
            return row[idx] if idx is not None and idx < len(row) else None

        category, clue, answer = _clean(cell("category")), _clean(cell("clue")), _clean(cell("answer"))
        if not (category or clue or answer):
            continue
        value = parse_value(cell("value"))
        rnd = parse_round(cell("round")) or implied_round
        if rnd is None:
            rnd = "final" if value is None else "1"
        # A blank category repeats the one above it in the same round, so it only has to be typed once.
        if category:
            last_category[rnd] = category
        elif rnd != "final":
            category = last_category.get(rnd, "")
        if not (category and clue and answer):
            warnings.append(f'Sheet "{sheet}" row {offset} skipped: needs a category, a question and an answer.')
            continue
        if rnd != "final" and value is None:
            warnings.append(f'Sheet "{sheet}" row {offset} skipped: round {rnd} clues need a point value.')
            continue
        out.append(
            {
                "game_id": _clean(cell("game_id")) or default_game,
                "round": rnd,
                "category": category,
                "value": None if rnd == "final" else value,
                "clue": clue,
                "answer": answer,
                "daily_double": _is_true(cell("daily_double")) and rnd != "final",
                "media": _clean(cell("media")) or None,
                "answer_media": _clean(cell("answer_media")) or None,
            }
        )
    return out


def parse_upload(data: bytes, filename: str, default_game: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Return (rows, warnings). Raises ImportProblem when nothing usable is found."""
    warnings: list[str] = []
    tables: list[tuple[str, list[list[Any]]]] = []
    if data[:2] == b"PK":
        from openpyxl import load_workbook

        try:
            workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except Exception as exc:  # noqa: BLE001 - openpyxl raises many types for bad files
            raise ImportProblem(f"Could not open the workbook: {exc}") from exc
        for sheet in workbook.worksheets:
            tables.append((sheet.title, [list(r) for r in sheet.iter_rows(values_only=True)]))
    else:
        text = data.decode("utf-8-sig", errors="replace")
        tables.append((filename or "CSV", [list(r) for r in csv.reader(io.StringIO(text))]))

    rows: list[dict[str, Any]] = []
    for sheet, table in tables:
        rows.extend(_rows_from_table(table, sheet, default_game, warnings))
    if not rows:
        raise ImportProblem(
            "No questions found. Use the template: columns Round, Category, Value, Question, Answer "
            "(and optional Daily Double)."
        )
    # Helper sheets (instructions, notes) without a header row are not worth a warning once questions loaded.
    warnings[:] = [w for w in warnings if not w.startswith(_NO_HEADER_PREFIX)]
    if len(rows) > MAX_ROWS:
        raise ImportProblem(f"Too many rows ({len(rows)}); the limit is {MAX_ROWS}.")
    finals: dict[str, int] = {}
    for row in rows:
        if row["round"] == "final":
            finals[row["game_id"]] = finals.get(row["game_id"], 0) + 1
    for game, count in finals.items():
        if count > 1:
            warnings.append(f'"{game}" has {count} Final Jeopardy clues; only the first one is played.')
    for order, row in enumerate(rows):
        row["sort_order"] = order
    return rows, warnings


TEMPLATE_CATEGORIES = 6
TEMPLATE_ROUNDS = (("Jeopardy", (200, 400, 600, 800, 1000)), ("Double Jeopardy", (400, 800, 1200, 1600, 2000)))


def build_template() -> bytes:
    """A ready-to-fill board: 6 categories x 5 clues for each round, plus Final Jeopardy."""
    from openpyxl import Workbook
    from openpyxl.comments import Comment
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.worksheet.datavalidation import DataValidation

    blue, light, round2, final_fill, entry = "009FDB", "E6F6FC", "EEF0FB", "FFF4D6", "FFFDE7"
    thin = Side(style="thin", color="C9D3DD")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    wrap = Alignment(wrap_text=True, vertical="top")
    center = Alignment(horizontal="center", vertical="top")

    wb = Workbook()
    ws = wb.active
    ws.title = "Questions"
    headers = ["Round", "Category", "Value", "Question", "Answer", "Daily Double", "Media", "Answer Media"]
    ws.append(headers)
    notes = {
        "Round": "Jeopardy, Double Jeopardy or Final. Already filled in.",
        "Category": "Type the category name on the first row of each block of 5 (yellow). The rows below copy it.",
        "Value": "Dollar value shown on the board. Already filled in; change it if you like.",
        "Question": "The clue shown on the board and read by the host.",
        "Answer": 'The correct response the host checks, e.g. "What is EBITDA?"',
        "Daily Double": "Optional. Put Y on a clue to make it a Daily Double. Leave every row blank and the "
        "game places 1 in Jeopardy and 2 in Double Jeopardy at random.",
        "Media": "Optional picture, video or sound for the clue: the file name of a file uploaded under "
        "Manage questions > Media files (e.g. q1-logo.png or ceo-clip.mp4), or a web link.",
        "Answer Media": "Optional picture, video or sound shown when the correct response is revealed "
        "(it replaces the clue's Media on screen). Same rules as the Media column.",
    }
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=blue)
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border
        cell.comment = Comment(notes[cell.value], "Christmas Jeopardy")

    def style_row(row: int, fill: str, first_of_category: bool) -> None:
        for col in range(1, 9):
            c = ws.cell(row=row, column=col)
            c.border = border
            c.alignment = center if col in (1, 3, 6) else wrap
            c.fill = PatternFill("solid", fgColor=fill)
        if first_of_category:
            ws.cell(row=row, column=2).fill = PatternFill("solid", fgColor=entry)
            ws.cell(row=row, column=2).font = Font(bold=True)
        else:
            ws.cell(row=row, column=2).font = Font(color="7A8794")

    row = 2
    for (round_name, values), fill in zip(TEMPLATE_ROUNDS, (light, round2)):
        for _ in range(TEMPLATE_CATEGORIES):
            first = row
            for k, value in enumerate(values):
                category = None if k == 0 else f'=IF(B{first}="","",B{first})'
                ws.append([round_name, category, value, None, None, None, None, None])
                ws.cell(row=row, column=3).number_format = '"$"#,##0'
                style_row(row, fill, k == 0)
                row += 1
    ws.append(["Final Jeopardy", None, None, None, None, None, None, None])
    style_row(row, final_fill, True)
    ws.cell(row=row, column=3).fill = PatternFill("solid", fgColor="D9DEE4")
    ws.cell(row=row, column=6).fill = PatternFill("solid", fgColor="D9DEE4")
    last = row

    dd = DataValidation(type="list", formula1='"Y"', allow_blank=True)
    dd.error = "Put Y for a Daily Double, or leave it blank."
    dd.errorTitle = "Daily Double"
    ws.add_data_validation(dd)
    dd.add(f"F2:F{last - 1}")

    for letter, width in zip("ABCDEFGH", (17, 28, 10, 70, 42, 13, 30, 30)):
        ws.column_dimensions[letter].width = width
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:H{last}"

    help_ws = wb.create_sheet("How to fill in")
    lines = (
        ("How to fill in this file", True),
        ("", False),
        ("1. On the Questions sheet, type a category name in each yellow cell. The 4 rows below it fill in automatically.", False),
        ("2. Type the Question (the clue shown on the board) and the Answer (the correct response) on every row.", False),
        ("3. Fill in the Final Jeopardy row at the bottom: category, question and answer (no value).", False),
        ("4. Optional: put Y in the Daily Double column of the clues you want as Daily Doubles.", False),
        ("   Leave it blank and the game places 1 in Jeopardy and 2 in Double Jeopardy at random.", False),
        ("5. Optional: for a picture, video or sound clue, put the file name in the Media column (see below).", False),
        ("6. Save, then in the app open Manage questions, give the set a name, choose this file and click Upload and save.", False),
        ("", False),
        ("Tips", True),
        ("- A full board is 6 categories x 5 clues per round. Fewer categories also work: leave unused blocks completely empty.", False),
        ("- Values can be changed. Rows with a Question but no Answer (or the other way round) are skipped and reported.", False),
        ("- Uploading a set with a name that already exists replaces it.", False),
        ("- To keep several sets in one file, add a column named Game with the set name on each row.", False),
        ("", False),
        ("Pictures, videos and sound", True),
        ("- Upload the files first: Manage questions > Media files. Then type the exact file name in the Media column, e.g. ceo-clip.mp4.", False),
        ("- Pictures: .png .jpg .gif .webp .svg   Video: .mp4 .webm .m4v .mov   Sound: .mp3 .wav .m4a .ogg   (up to 100 MB each).", False),
        ("- A web link also works: a direct link to a picture or video file, or a YouTube or Vimeo link.", False),
        ("  SharePoint, OneDrive and Stream links usually need a sign-in and will not play; download the file and upload it instead.", False),
        ('- Still type a Question for media clues (e.g. "Name the company behind this logo"). It is shown with the picture or video.', False),
        ("- To show a picture, video or sound with the correct response, put its file name in the Answer Media column.", False),
        ("- Videos and sound play when the clue opens. With Open buzzers automatically on, the buzzers open when the video ends.", False),
        ("- Video tip: record the person reading the clue, export it as .mp4 (H.264) and keep it short.", False),
    )
    for text, bold in lines:
        help_ws.append([text])
        if bold:
            help_ws.cell(row=help_ws.max_row, column=1).font = Font(bold=True, size=13, color=blue)
    help_ws.column_dimensions["A"].width = 120

    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()
