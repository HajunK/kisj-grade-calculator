from copy import deepcopy
from datetime import date

from PIL import Image, ImageDraw
import pytest

import menu_scraper.ocr as ocr
from menu_scraper.ocr import combine, confirmed_closures, date_columns, layout, printed_dates, section_name


def test_uses_printed_week_and_handles_year_rollover():
    assert printed_dates("Weekly Menu 2026.12.28 ~ 2027.01.03") == (
        date(2026, 12, 28), date(2027, 1, 3),
    )


@pytest.mark.parametrize("value", ["November week 2", "2026.11.09 ~ 2026.11.14",
                                  "2026.11.10 ~ 2026.11.16"])
def test_unreadable_or_invalid_week_is_not_published(value):
    with pytest.raises(ValueError):
        printed_dates(value)


def page(language="en"):
    return {"language": language, "weekStart": "2026-11-09", "weekEnd": "2026-11-15",
            "days": [{"date": f"2026-11-{day:02d}", "meals": {
                meal: [{"section": "A", "text": language, "status": "printed"}]
                for meal in ("breakfast", "lunch", "dinner")}} for day in range(9, 16)],
            "sharedSections": [], "notes": "printed notes"}


def test_bilingual_pages_merge_by_printed_date_and_meal():
    menu = combine([page("ko"), page("en")])
    assert menu["school"] == "HS"
    assert len(menu["days"]) == 7
    assert menu["days"][0]["meals"]["lunch"]["ko"][0]["text"] == "ko"
    assert menu["days"][0]["meals"]["lunch"]["en"][0]["text"] == "en"


def test_disagreeing_dates_or_duplicate_language_fail_closed():
    wrong = deepcopy(page("ko"))
    wrong["weekStart"] = "2026-11-16"
    with pytest.raises(ValueError, match="disagree"):
        combine([page(), wrong])
    with pytest.raises(ValueError, match="Multiple pages"):
        combine([page(), page()])


def test_section_mapping_preserves_alternatives():
    assert section_name("채식", "lunch") == "vegan"
    assert section_name("B", "lunch") == "B"
    assert section_name("PLUS BAR", "dinner") == "always"
    with pytest.raises(ValueError):
        section_name("???", "lunch")


def closure_table():
    image = Image.new("RGB", (901, 801), "white")
    drawing = ImageDraw.Draw(image)
    drawing.rectangle((0, 50, 900, 100), fill=(250, 110, 20))
    drawing.rectangle((661, 102, 899, 698), fill=(250, 230, 200))
    for x in (60, 180, 300, 420, 540, 660):
        drawing.line((x, 101, x, 698), fill=(190, 190, 190))
    for y in (300, 500, 700):
        drawing.line((0, y, 660, y), fill=(250, 110, 20))
    return image


def test_partial_meal_dividers_and_one_merged_date_pair_have_regular_geometry():
    columns, _, bands, missing = layout(closure_table())
    assert columns == [60, 180, 300, 420, 540, 660, 780, 900]
    assert missing == [6]
    assert [band[0] for band in bands] == [50, 300, 500, 700]


def test_irregular_or_insufficient_grid_cannot_invent_date_columns():
    with pytest.raises(ValueError, match="regular grid"):
        date_columns([60, 180, 300, 450, 540, 660], 901)
    with pytest.raises(ValueError, match="enough date columns"):
        date_columns([60, 180, 300, 420, 660], 901)


def test_decorative_panel_requires_explicit_full_region_closure_evidence(monkeypatch):
    image = closure_table()
    columns, _, bands, missing = layout(image)
    monkeypatch.setattr(ocr.pytesseract, "image_to_string", lambda *args, **kwargs: "Fall Break")
    with pytest.raises(ValueError, match="no confirmed"):
        confirmed_closures(image, columns, bands, missing)
    monkeypatch.setattr(ocr.pytesseract, "image_to_string", lambda *args, **kwargs: "Fall Break\nCAFETERIA CLOSED")
    closures = confirmed_closures(image, columns, bands, missing)
    assert set(closures) == {5, 6}
    assert closures[5]["sourceColumns"] == [6, 7]
    assert closures[5]["scope"] == "allMeals"


def test_missing_separator_without_colored_panel_fails_closed(monkeypatch):
    image = closure_table()
    columns, _, bands, missing = layout(image)
    ImageDraw.Draw(image).rectangle((661, 102, 899, 698), fill="white")
    monkeypatch.setattr(ocr.pytesseract, "image_to_string", lambda *args, **kwargs: "CAFETERIA CLOSED")
    with pytest.raises(ValueError, match="colored closure panel"):
        confirmed_closures(image, columns, bands, missing)


def test_closed_dates_never_pass_decorative_images_to_food_ocr(monkeypatch):
    def fake_text(image, *args, **kwargs):
        assert ocr.color_fraction(image) < .1, "Closure artwork must never become food text"
        return "A" if image.width < 40 else "White Rice and soup, printed menu content " * 3

    monkeypatch.setattr(ocr, "text", fake_text)
    monkeypatch.setattr(ocr, "printed_dates", lambda value: (date(2026, 10, 26), date(2026, 11, 1)))
    monkeypatch.setattr(ocr.pytesseract, "image_to_string", lambda *args, **kwargs: "CAFETERIA CLOSED")
    page = ocr.read_page(closure_table())
    for day in page["days"][:5]:
        assert all(options[0]["status"] == "printed" for options in day["meals"].values())
    for day in page["days"][5:]:
        assert all(options[0]["status"] == "closed" for options in day["meals"].values())
        assert all(options[0]["lines"] == [] for options in day["meals"].values())
