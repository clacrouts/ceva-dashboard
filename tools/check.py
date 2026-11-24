"""Check the dashboard in headless Chromium: it loads, shows the coast, opens a transect, switches language
(French, then Arabic right to left and Chinese), filters the map and opens the summary by country, and the
validation page draws its charts.

    python tools/serve.py 8000 &
    python tools/check.py http://localhost:8000/ screenshots

Prints what a visitor would read and any console error, and saves screenshots (desktop and phone).
Needs Playwright and its Chromium (``pip install playwright`` then ``playwright install chromium``).
The OpenFreeMap basemap logs a few "Expected value to be of type number" warnings at high zoom; they
come from its style, not from the dashboard, and are not reported.
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]   # WebGL without a GPU
IDLE = "window.ceva.map.loaded() && window.ceva.map.areTilesLoaded()"


def main(url: str, out: str) -> int:
    os.makedirs(out, exist_ok=True)
    problems = []

    def keep(message):
        if message.type == "error" or (message.type == "warning" and "Expected value" not in message.text):
            problems.append(f"{message.type}: {message.text}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=GL)
        page = browser.new_page(viewport={"width": 1400, "height": 860})
        page.on("console", keep)
        page.on("pageerror", lambda error: problems.append(f"page error: {error}"))
        page.goto(url, wait_until="networkidle")
        page.wait_for_function("window.ceva && window.ceva.state.manifest", timeout=30000)
        page.wait_for_function(IDLE, timeout=60000)
        time.sleep(1.5)
        page.screenshot(path=f"{out}/1_overview.png")
        print("headline:", page.inner_text("#headline"))

        # zoom on the first transect drawn, then open its card
        where = page.evaluate("window.ceva.map.queryRenderedFeatures({layers: ['dots']})[0]?.geometry.coordinates")
        if not where:
            problems.append("no transect drawn on the overview")
        else:
            page.evaluate(f"window.ceva.map.jumpTo({{center: {where}, zoom: 12.5}})")
            page.wait_for_function(IDLE, timeout=60000)
            time.sleep(1.5)
            page.evaluate("""() => { const dots = window.ceva.map.queryRenderedFeatures({layers: ['dots']});
                window.ceva.select((dots.find(f => f.properties.sig === 1) || dots[0]).properties); }""")
            page.wait_for_selector("#chart canvas", timeout=20000)
            time.sleep(1)
            print("card:", page.inner_text("#card-rate"), "|", page.inner_text("#card-class"))
            print("     ", page.inner_text("#card-text"))
            refs = page.evaluate("window.ceva.state.manifest.files.refs ? document.querySelectorAll('#card-refs tbody tr').length : null")
            if refs is not None:
                print("     ", f"{refs} other products on this card;", page.inner_text("#chart-keys").replace("\n", " | "))
            page.screenshot(path=f"{out}/2_card.png")
            page.select_option("#lang", "fr")
            page.wait_for_function("document.documentElement.lang.startsWith('fr')", timeout=10000)
            time.sleep(0.5)
            print("FR:  ", page.inner_text("#card-rate"), "|", page.inner_text("#card-text"))
            page.select_option("#lang", "en")
            page.wait_for_function("document.documentElement.lang.startsWith('en')", timeout=10000)
            if page.evaluate("[...document.querySelectorAll('#colour-by option')].some(o => o.value === 'smd')"):
                page.select_option("#colour-by", "smd")
                page.wait_for_function(IDLE, timeout=60000)
                time.sleep(1)
                page.screenshot(path=f"{out}/2b_monitor.png")
        page.click("#about-button")
        time.sleep(0.5)
        page.screenshot(path=f"{out}/3_about.png")
        page.keyboard.press("Escape")

        # filters: erosion faster than 1 m/yr, significant only; then the summary by country
        page.evaluate("window.ceva.map.getSource('selected')?.setData({type: 'FeatureCollection', features: []})")
        page.click("#card-close") if page.is_visible("#card-close") else None
        page.wait_for_function("window.ceva.state.stats", timeout=30000)
        page.evaluate("window.ceva.setFilters({ change: 'erosion1', sig: true })")
        page.evaluate("window.ceva.map.fitBounds(window.ceva.state.manifest.bounds, { duration: 0, padding: 60 })")
        page.wait_for_function(IDLE, timeout=60000)
        time.sleep(1.5)
        page.screenshot(path=f"{out}/7_filtered.png")
        print("filtered:", page.inner_text("#filtered"), "|", page.inner_text("#headline"))
        shown = page.evaluate("[...new Set(window.ceva.map.queryRenderedFeatures({layers: ['dots']}).map(f => f.properties.cls))]")
        if any(c not in ("intense_erosion", "severe_erosion", "extreme_erosion") for c in shown):
            problems.append(f"the change filter lets other classes through: {shown}")
        page.click("#country-button")
        page.wait_for_selector("#country-table tbody tr", timeout=10000)
        time.sleep(0.5)
        rows = page.locator("#country-table tbody tr")
        print("countries:", rows.count(), "|", rows.first.inner_text().replace("\t", " · "), "|",
              page.inner_text("#country-table tfoot").replace("\t", " · "))
        page.screenshot(path=f"{out}/8_countries.png")
        page.keyboard.press("Escape")
        page.evaluate("window.ceva.setFilters({ change: 'all', sig: false })")

        # right to left (Arabic) and Chinese
        for lang, shot in (("ar", "9_arabic"), ("zh", "10_chinese")):
            page.select_option("#lang", lang)
            page.wait_for_function(f"document.documentElement.lang.startsWith('{lang}')", timeout=10000)
            time.sleep(1)
            if lang == "ar" and page.evaluate("document.documentElement.dir") != "rtl":
                problems.append("Arabic is not laid out right to left")
            print(f"{lang}:   ", page.inner_text("#headline"))
            page.screenshot(path=f"{out}/{shot}.png")
        page.select_option("#lang", "en")

        report = browser.new_page(viewport={"width": 1280, "height": 900})
        report.on("console", keep)
        report.on("pageerror", lambda error: problems.append(f"validation page error: {error}"))
        report.goto(url.rstrip("/") + "/validation.html", wait_until="networkidle")
        try:
            report.wait_for_function("window.cevaReport && window.cevaReport.state.data", timeout=30000)
            time.sleep(1.5)
            charts = report.evaluate("document.querySelectorAll('#report canvas').length")
            products = report.evaluate("document.querySelectorAll('section.product').length")
            print("validation:", f"{products} products, {charts} charts;", report.inner_text("#short").split("\n")[0:2])
            report.screenshot(path=f"{out}/5_validation.png")
            # one image per section (a full-page capture of a long page repeats itself in Chromium)
            report.add_style_tag(content=".page-head { position: static; }")
            for i, section in enumerate(report.locator("#report > section:not(#products), section.product").all()):
                section.screenshot(path=f"{out}/5_validation_{i}.png")
            mobile = browser.new_page(viewport={"width": 390, "height": 800}, device_scale_factor=2)
            mobile.on("pageerror", lambda error: problems.append(f"validation phone error: {error}"))
            mobile.goto(url.rstrip("/") + "/validation.html", wait_until="networkidle")
            mobile.wait_for_function("window.cevaReport && window.cevaReport.state.data", timeout=30000)
            time.sleep(1)
            if mobile.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"):
                problems.append("validation page scrolls sideways on a phone")
            mobile.screenshot(path=f"{out}/6_validation_phone.png")
            mobile.select_option("#lang", "ar")
            mobile.wait_for_function("document.documentElement.dir === 'rtl'", timeout=10000)
            time.sleep(1)
            if mobile.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"):
                problems.append("validation page scrolls sideways on a phone in Arabic")
            mobile.screenshot(path=f"{out}/6b_validation_phone_arabic.png")
        except Exception as error:                      # no validation.json: an older publication
            print("validation page not checked:", error)

        phone = browser.new_page(viewport={"width": 390, "height": 800}, device_scale_factor=2)
        phone.on("pageerror", lambda error: problems.append(f"phone page error: {error}"))
        phone.goto(url, wait_until="networkidle")
        phone.wait_for_function("window.ceva && window.ceva.state.manifest", timeout=30000)
        time.sleep(2)
        phone.screenshot(path=f"{out}/4_phone.png")
        browser.close()
    print("console problems:", problems or "none")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "screenshots"))
