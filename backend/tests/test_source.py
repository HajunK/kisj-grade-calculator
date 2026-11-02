import io

from PIL import Image
import pytest

from menu_scraper.source import Post, parse_post, parse_posts, render, school_url, source_hash


def test_listing_excludes_es_ms_and_pinned_notices_even_on_hs_filter():
    html = """<table>
    <td class="kboard-list-title"><a href="?mod=document&amp;uid=99">[ES/MS] Weekly</a></td>
    <td class="kboard-list-title"><a href="?mod=document&amp;uid=101">Payment notice</a></td>
    <td class="kboard-list-title"><a href="?mod=document&amp;uid=97">[HS] Older menu</a></td>
    <td class="kboard-list-title"><a href="?mod=document&amp;uid=100">[HS] New menu</a></td>
    </table>"""
    assert [post.uid for post in parse_posts(html)] == ["100", "97"]


def test_post_uses_only_content_images_and_prefers_pdf_attachment():
    post = Post("100", "[HS] Weekly", "https://kis.ac/cafeteria-menus/?uid=100")
    html = """<img src="/logo.png"><div id="kboard-document">
      <div class="kboard-title">[HS] Weekly</div>
      <div class="detail-date"><div class="detail-value">2026-10-30 17:34</div></div>
      <div class="kboard-content"><img src="/ko.png"><img src="/en.png"></div>
      <a href="/menu.pdf">Download</a></div>"""
    parsed, assets = parse_post(html, post)
    assert parsed.published_at == "2026-10-30 17:34"
    assert assets == ["https://kis.ac/menu.pdf"]
    _, assets = parse_post(html.replace('<a href="/menu.pdf">Download</a>', ''), post)
    assert assets == ["https://kis.ac/ko.png", "https://kis.ac/en.png"]


def test_post_revalidates_school_category():
    with pytest.raises(ValueError, match="not explicitly"):
        parse_post('<div id="kboard-document"><div class="kboard-title">[ES/MS] Menu</div></div>',
                   Post("100", "[HS] cached title", "https://kis.ac/"))


@pytest.mark.parametrize("url", ["http://kis.ac/menu.pdf", "https://kis.ac.evil.test/a.pdf",
                                  "https://other.test/menu.pdf", "https://user:pass@kis.ac/a.pdf"])
def test_rejects_offsite_downloads(url):
    with pytest.raises(ValueError):
        school_url(url)


def test_render_real_image_and_pdf_bytes():
    image = Image.new("RGB", (400, 500), "white")
    for format in ("PNG", "PDF"):
        buffer = io.BytesIO()
        image.save(buffer, format=format)
        pages = render(buffer.getvalue())
        assert len(pages) == 1
        assert pages[0].width >= 400


def test_revised_attachment_at_same_url_changes_content_hash():
    assert source_hash([("https://kis.ac/menu.png", b"old")]) != source_hash([
        ("https://kis.ac/menu.png", b"revised"),
    ])
