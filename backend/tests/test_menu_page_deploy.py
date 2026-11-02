import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("publish_menu_page", Path(__file__).parents[1] / "deploy/publish_menu_page.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def test_menu_publication_preserves_unrelated_spa_assets():
    live = {"/index.html": "live-app", "/assets/app.js": "live-bundle", "/fonts/main.woff2": "font"}
    merged = deploy.preserve_files(live, {"/menu.html": "new-page", "/menu-assets/js/menu.js": "new-js"})
    assert all(merged[path] == digest for path, digest in live.items())
    assert live == {"/index.html": "live-app", "/assets/app.js": "live-bundle", "/fonts/main.woff2": "font"}
    with pytest.raises(ValueError):
        deploy.preserve_files(live, {"/index.html": "older-checkout"})


def test_page_dependencies_stay_in_isolated_namespace():
    files = deploy.page_files(Path(__file__).parents[2] / "public")
    html = files["/menu.html"].decode()
    assert '/menu-assets/js/menu.js' in html
    assert '/menu-assets/js/auth.js' in html
    assert '/menu-assets/css/menu.css' in html
    assert "boot.js" not in html
    assert all(path == "/menu.html" or path.startswith("/menu-assets/") for path in files)
