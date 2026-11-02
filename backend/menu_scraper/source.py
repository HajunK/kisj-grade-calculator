"""Discover only HS KBoard posts and download their menu attachments."""

from dataclasses import dataclass
import hashlib
import io
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup
from PIL import Image
import pypdfium2 as pdfium
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

MENU_URL = "https://kis.ac/cafeteria-menus/"
MAX_BYTES = 25 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 30_000_000


@dataclass(frozen=True)
class Post:
    uid: str
    title: str
    url: str
    published_at: str = ""


def school_url(url: str, base: str = MENU_URL) -> str:
    url = urljoin(base, url)
    parsed = urlparse(url)
    if (parsed.scheme != "https" or parsed.hostname not in {"kis.ac", "www.kis.ac"}
            or parsed.username or parsed.password or parsed.port not in {None, 443}):
        raise ValueError("Menu source must be an HTTPS URL on kis.ac")
    return url


def session() -> requests.Session:
    client = requests.Session()
    client.headers["User-Agent"] = "KISJ-HS-Menu/1.0 (+https://kisjcalc.com)"
    client.mount("https://", HTTPAdapter(max_retries=Retry(
        total=3, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )))
    return client


def fetch(client: requests.Session, url: str) -> bytes:
    # Validate every redirect before making the next request.
    for _ in range(6):
        url = school_url(url)
        with client.get(url, timeout=(10, 60), stream=True, allow_redirects=False) as response:
            if response.is_redirect:
                url = school_url(response.headers["Location"], url)
                continue
            response.raise_for_status()
            chunks, size = [], 0
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError("Menu response exceeds 25 MiB")
                chunks.append(chunk)
            return b"".join(chunks)
    raise ValueError("Too many menu source redirects")


def parse_posts(html: str) -> list[Post]:
    soup = BeautifulSoup(html, "html.parser")
    posts = {}
    for link in soup.select(".kboard-list-title a"):
        title = link.get_text(" ", strip=True)
        # Category filter alone is insufficient: notices and ES/MS may still appear.
        if not title.upper().startswith("[HS]"):
            continue
        url = school_url(link.get("href", ""))
        uid = parse_qs(urlparse(url).query).get("uid", [""])[0]
        if uid.isdigit():
            posts[uid] = Post(uid, title, url)
    return sorted(posts.values(), key=lambda p: int(p.uid), reverse=True)


def discover(client: requests.Session, limit: int) -> list[Post]:
    url = MENU_URL + "?category1=%5BHS%5D&mod=list"
    posts = parse_posts(fetch(client, url).decode("utf-8"))
    if not posts:
        raise ValueError("No HS posts found; refusing to ingest another school category")
    return posts[:limit]


def parse_post(html: str, post: Post) -> tuple[Post, list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    title_node = soup.select_one("#kboard-document .kboard-title")
    if not title_node or not title_node.get_text(strip=True).upper().startswith("[HS]"):
        raise ValueError("Post is not explicitly labeled [HS]")
    date = soup.select_one(".detail-date .detail-value")
    post = Post(post.uid, title_node.get_text(" ", strip=True), post.url,
                date.get_text(strip=True) if date else "")
    content = soup.select_one("#kboard-document .kboard-content")
    if not content:
        raise ValueError("HS post has no menu content")
    pdfs = []
    for link in soup.select("#kboard-document a[href], #kboard-document iframe[src], #kboard-document embed[src], #kboard-document object[data]"):
        href = link.get("href") or link.get("src") or link.get("data")
        if ".pdf" in href.lower() or "kboard_file_download" in href.lower():
            pdfs.append(school_url(href, post.url))
    images = [school_url(node.get("data-src") or node["src"], post.url)
              for node in content.select("img[src], img[data-src]")]
    assets = list(dict.fromkeys(pdfs or images))
    if not assets:
        raise ValueError("HS post has no PDF or menu images")
    if len(assets) > 8:
        raise ValueError("Unexpectedly many menu attachments")
    return post, assets


def render(data: bytes) -> list[Image.Image]:
    if data.startswith(b"%PDF-"):
        document = pdfium.PdfDocument(data)
        try:
            if not 1 <= len(document) <= 8:
                raise ValueError("PDF must contain 1-8 menu pages")
            images = []
            for index in range(len(document)):
                page = document[index]
                try:
                    scale = min(3, 3300 / page.get_width())
                    if page.get_width() * page.get_height() * scale**2 > 30_000_000:
                        raise ValueError("Rendered PDF page exceeds pixel limit")
                    bitmap = page.render(scale=scale)
                    try:
                        images.append(bitmap.to_pil().convert("RGB"))
                    finally:
                        bitmap.close()
                finally:
                    page.close()
            return images
        finally:
            document.close()
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > 30_000_000:
            raise ValueError("Menu image exceeds pixel limit")
        return [image.convert("RGB")]


def source_hash(assets: list[tuple[str, bytes]]) -> str:
    digest = hashlib.sha256()
    for url, data in assets:
        digest.update(url.encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(data).digest())
    return digest.hexdigest()
