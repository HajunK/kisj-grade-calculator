"""OCR the printed table using detected grid lines, never guessed menu dates."""

from datetime import date, timedelta
import re

import numpy as np
from PIL import Image, ImageOps
import pytesseract

MEALS = ("breakfast", "lunch", "dinner")


def groups(values) -> list[np.ndarray]:
    return [g for g in np.split(values, np.where(np.diff(values) > 1)[0] + 1) if len(g)]


def text(image: Image.Image, language: str = "eng", psm: int = 6) -> str:
    # Remove pale cell backgrounds/grid lines. Preserve dark Korean/English glyphs.
    gray = ImageOps.grayscale(image)
    binary = gray.point(lambda value: 255 if value > 170 else 0)
    bounds = ImageOps.invert(binary).getbbox()
    if bounds is None:
        return ""
    binary = binary.crop(bounds)
    if binary.height < 40:
        scale = max(2, 40 // binary.height)
        binary = binary.resize((binary.width * scale, binary.height * scale))
    binary = ImageOps.expand(binary, border=12, fill=255)
    return pytesseract.image_to_string(
        binary, lang=language, config=f"--psm {psm}", timeout=90,
    ).strip()


def printed_dates(value: str) -> tuple[date, date]:
    parts = re.findall(r"(20\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})", value)
    if len(parts) != 2:
        raise ValueError(f"Could not read exactly two printed week dates: {value!r}")
    start, end = [date(*map(int, match)) for match in parts]
    if end - start != timedelta(days=6) or start.weekday() != 0:
        raise ValueError("Printed menu range must be Monday through Sunday")
    return start, end


def date_columns(lines: list[int], width: int) -> tuple[list[int], list[int]]:
    """Recover one merged date boundary only when the remaining grid is regular."""
    if len(lines) >= 7:
        return lines[-7:] + [width - 1], []
    if len(lines) != 6:
        raise ValueError("Could not identify enough date columns for a reviewed layout")
    observed = lines + [width - 1]
    gaps = np.diff(observed)
    spacing = float(np.median(gaps))
    multiples = np.rint(gaps / spacing).astype(int)
    if (spacing < width * .08 or np.count_nonzero(multiples == 2) != 1
            or np.count_nonzero(multiples == 1) != 5
            or np.any(np.abs(gaps - multiples * spacing) > spacing * .12)):
        raise ValueError("Missing date separator cannot be recovered from a regular grid")
    # A merged pair may have modestly different printed widths. Its midpoint is
    # sufficient to identify the two dates, whose common closure is checked below.
    gap_index = int(np.where(multiples == 2)[0][0])
    boundary = round((observed[gap_index] + observed[gap_index + 1]) / 2)
    columns = observed[:gap_index + 1] + [boundary] + observed[gap_index + 1:]
    return columns, [gap_index + 1]


def layout(image: Image.Image) -> tuple[list[int], list[int], list[tuple[int, int]], list[int]]:
    pixels = np.asarray(image.convert("RGB")).astype(np.int16)
    orange = ((pixels[:, :, 0] > 190) & (pixels[:, :, 1] > 65)
              & (pixels[:, :, 1] < 180) & (pixels[:, :, 2] < 100))
    row_coverage = orange.mean(axis=1)
    bands = [(int(g[0]), int(g[-1])) for g in groups(np.where(row_coverage > .55)[0])]
    # Header, breakfast end, lunch end, dinner end. Later bands belong to footer.
    if (len(bands) < 4 or bands[0][1] - bands[0][0] < 20
            or row_coverage[bands[0][0]:bands[0][1] + 1].min() <= .75):
        raise ValueError("Unrecognized menu table: orange header/meal dividers missing")
    top, bottom = bands[0][1] + 1, bands[3][0]
    neutral = ((pixels.max(axis=2) - pixels.min(axis=2) < 15)
               & (pixels.mean(axis=2) < 240))
    lines = [int(np.mean(g)) for g in groups(np.where(neutral[top:bottom].mean(axis=0) > .35)[0])
             if len(g) <= 4]
    columns, missing_boundaries = date_columns(lines, image.width)
    widths = np.diff(columns)
    if min(widths) < image.width * .08 or max(widths) / min(widths) > 1.3:
        raise ValueError("Menu date columns have unexpected widths")
    gutter_left, gutter_right = int(columns[0] * .55), columns[0] - 3
    row_lines = [int(np.mean(g)) for g in groups(np.where(
        neutral[:, gutter_left:gutter_right].mean(axis=1) > .85,
    )[0]) if len(g) <= 5]
    return columns, row_lines, bands, missing_boundaries


def color_fraction(image: Image.Image) -> float:
    pixels = np.asarray(image.convert("RGB")).astype(np.int16)
    return float((pixels.max(axis=2) - pixels.min(axis=2) > 30).mean())


def confirmed_closures(image: Image.Image, columns: list[int], bands: list[tuple[int, int]],
                       missing_boundaries: list[int]) -> dict[int, dict]:
    closures = {}
    for boundary in missing_boundaries:
        first, stop = boundary - 1, boundary + 1
        region = image.crop((columns[first] + 4, bands[0][1] + 4,
                             columns[stop] - 4, bands[3][0] - 4))
        if color_fraction(region) < .1:
            raise ValueError("Missing date separator is not a recognized colored closure panel")
        # The closure notice is a single image spanning the whole meal table.
        # Preserve its low-contrast brown lettering instead of thresholding it.
        gray = ImageOps.grayscale(region)
        for scale in (1, 2):
            prepared = gray if scale == 1 else gray.resize((gray.width * scale, gray.height * scale))
            evidence = pytesseract.image_to_string(prepared, lang="kor+eng", config="--psm 11", timeout=90).strip()
            normalized = re.sub(r"\s+", "", evidence).lower()
            if "cafeteriaclosed" in normalized or "미운영" in normalized:
                break
        else:
            raise ValueError("Merged date columns have no confirmed cafeteria-closed notice")
        details = {"text": evidence, "scope": "allMeals", "sourceColumns": [first + 1, stop]}
        for index in range(first, stop):
            closures[index] = details
    return closures


def section_name(label: str, meal: str) -> str:
    normalized = re.sub(r"[^a-z가-힣]", "", label.lower())
    if "always" in normalized or "plus" in normalized or "bar" in normalized:
        return "always"
    if "special" in normalized:
        return "special"
    if "vegan" in normalized or "채식" in normalized:
        return "vegan"
    if normalized == "b":
        return "B"
    if normalized in {"a", "d", "breakfast"}:
        return "A"
    raise ValueError(f"Unrecognized {meal} section label: {label!r}")


def read_page(image: Image.Image) -> dict:
    columns, row_lines, bands, missing_boundaries = layout(image)
    start, end = printed_dates(text(image.crop((
        int(image.width * .3), 0, int(image.width * .7), bands[0][0],
    ))))
    sample = text(image.crop((columns[1] + 4, bands[0][1] + 4,
                              columns[2] - 4, bands[1][0] - 4)), "kor+eng")
    language = "ko" if len(re.findall(r"[가-힣]", sample)) > 3 else "en"
    ocr_language = "kor+eng" if language == "ko" else "eng"
    closures = confirmed_closures(image, columns, bands, missing_boundaries)
    days = [{"date": (start + timedelta(days=i)).isoformat(), "meals": {}} for i in range(7)]
    shared = []
    for meal_index, meal in enumerate(MEALS):
        top, bottom = bands[meal_index][1] + 1, bands[meal_index + 1][0]
        boundaries = [top] + [y for y in row_lines if top + 8 < y < bottom - 8] + [bottom]
        seen = set()
        for upper, lower in zip(boundaries, boundaries[1:]):
            if lower - upper < 16:
                continue
            label_image = image.crop((int(columns[0] * .55), upper + 3,
                                       columns[0] - 3, lower - 3))
            # Single A/B labels need line mode, Korean 채식 needs its language pack.
            for label_language, psm in (("eng", 6), ("kor+eng", 6), ("eng", 7), ("kor+eng", 7)):
                label = text(label_image, label_language, psm=psm)
                try:
                    section = section_name(label, meal)
                    break
                except ValueError:
                    continue
            else:
                raise ValueError(f"Unrecognized {meal} section label: {label!r}")
            if section in seen:
                raise ValueError(f"Duplicate {meal} section {section}")
            seen.add(section)
            if section == "always":
                # These cells span several dates. Do not split a sentence across days.
                right = image.width - 4
                if closures:
                    closed_left = columns[min(closures)]
                    closed_crop = image.crop((closed_left + 4, upper + 3, right, lower - 3))
                    if color_fraction(closed_crop) > .1:
                        right = closed_left - 4
                shared.append({"meal": meal, "section": section, "text": text(image.crop((
                    columns[0] + 4, upper + 3, right, lower - 3,
                )), ocr_language), **({"excludedDates": [days[index]["date"] for index in closures]}
                                        if closures else {})})
                continue
            for day_index, (left, right) in enumerate(zip(columns, columns[1:])):
                if day_index in closures:
                    continue
                cell = image.crop((left + 4, upper + 4, right - 4, lower - 4))
                value = text(cell, ocr_language)
                if not value and np.count_nonzero(np.asarray(ImageOps.grayscale(cell)) < 170) > 30:
                    value = text(cell, ocr_language, psm=11)
                    if not value:
                        raise ValueError(f"Unreadable printed text in {meal}/{section}, day {day_index + 1}")
                lines = [line.strip() for line in value.splitlines() if line.strip() not in {"", "-", "_"}]
                days[day_index]["meals"].setdefault(meal, []).append({
                    "section": section, "text": value, "lines": lines,
                    "status": "printed" if lines else ("placeholder" if value else "blank"),
                })
        if "A" not in seen:
            raise ValueError(f"No main {meal} section identified")
        for day_index, evidence in closures.items():
            days[day_index]["meals"][meal] = [{
                "section": "closure", "text": "", "lines": [], "status": "closed",
                "closure": evidence,
            }]
    if sum(len(option["text"]) for day in days for options in day["meals"].values()
           for option in options) < 500:
        raise ValueError("Too little OCR text; refusing to publish an empty menu")
    return {
        "language": language, "weekStart": start.isoformat(), "weekEnd": end.isoformat(),
        "days": days, "sharedSections": shared,
        "notes": text(image.crop((0, bands[3][1] + 3, image.width, image.height - 2)), ocr_language),
    }


def combine(pages: list[dict]) -> dict:
    if not pages:
        raise ValueError("No menu pages were recognized")
    weeks = {(page["weekStart"], page["weekEnd"]) for page in pages}
    if len(weeks) != 1:
        raise ValueError("Attachments disagree on the printed week dates")
    languages = [page["language"] for page in pages]
    if len(set(languages)) != len(languages):
        raise ValueError("Multiple pages in one language need a reviewed layout adapter")
    days = []
    for index in range(7):
        days.append({"date": pages[0]["days"][index]["date"], "meals": {
            meal: {page["language"]: page["days"][index]["meals"][meal] for page in pages}
            for meal in MEALS
        }})
    return {
        "school": "HS", "weekStart": pages[0]["weekStart"], "weekEnd": pages[0]["weekEnd"],
        "languages": languages, "days": days,
        "sharedSections": {page["language"]: page["sharedSections"] for page in pages},
        "notes": {page["language"]: page["notes"] for page in pages},
    }
