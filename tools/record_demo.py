"""Record the SignalFlow demo video with Playwright (1920x1080).

One continuous take over all scenes; scene boundaries are written to
shots/demo/timestamps.json. tools/cut_demo.py then trims the take per scene,
lays the Alice voice-over (tools/voiceover.py output) on top and concatenates
everything to the final MP4.

Usage:  python tools/record_demo.py          # after python tools/voiceover.py
"""

import json
import pathlib
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8000"
OUT = pathlib.Path("shots/demo")
VO_DUR = json.loads((OUT / "vo" / "durations.json").read_text(encoding="utf-8"))

BUSYPOLL = "(() => !document.getElementById('btn-run').classList.contains('busy'))()"


class Take:
    def __init__(self, page):
        self.page = page
        self.t0 = time.perf_counter()
        self.marks = []

    def mark(self, scene):
        self.marks.append({"scene": scene, "start": round(time.perf_counter() - self.t0, 2)})

    def hold(self, scene, minimum=None):
        """Sleep until the scene lasts at least its voice-over length + pad."""
        vo = VO_DUR.get(f"seg{int(scene):02d}", 8.0)
        want = max(minimum or 0.0, vo + 4.0)
        elapsed = time.perf_counter() - self.t0 - self.marks[-1]["start"]
        if want > elapsed:
            time.sleep(want - elapsed)

    def slow_scroll(self, to_y, steps=6, dwell=0.35):
        cur = self.page.evaluate("window.scrollY")
        for i in range(1, steps + 1):
            self.page.evaluate(f"window.scrollTo(0, {cur + (to_y - cur) * i / steps})")
            time.sleep(dwell)


def scene_intro(t):
    t.page.goto(BASE + "/writeup.html")
    t.page.wait_for_timeout(1200)
    t.page.click("button[data-v='de-simple']")
    t.page.wait_for_timeout(900)
    t.slow_scroll(700, steps=4, dwell=0.7)
    t.hold(1)


def scene_junction(t):
    p = t.page
    p.goto(BASE + "/index.html")
    p.wait_for_function("() => document.querySelectorAll('.kpi-table tbody tr').length > 0",
                        timeout=180000)
    p.select_option("#ctl-mix", "city")
    time.sleep(0.6)
    p.click("#btn-simulate")
    p.wait_for_function("() => !document.getElementById('btn-simulate').classList.contains('busy')",
                        timeout=180000)
    p.wait_for_timeout(1200)
    t.page.evaluate("document.querySelector('.viewer').scrollIntoView({block:'start'})")
    time.sleep(0.8)
    t.hold(2)


def scene_toggles(t):
    p = t.page
    p.click(".pol-btn[data-pol='coordinated']")
    p.wait_for_timeout(500)
    p.click(".pol-btn[data-pol='tuned']")
    p.wait_for_timeout(500)
    p.evaluate("document.querySelector('.charts').scrollIntoView({block:'start'})")
    time.sleep(0.8)
    p.click(".cmode-btn[data-cmode='cum']")
    p.wait_for_timeout(400)
    p.click(".met-btn[data-met='co2']")
    p.wait_for_timeout(800)
    t.hold(3)


def scene_agent(t):
    p = t.page
    p.evaluate("window.scrollTo(0, 0)")
    time.sleep(0.5)
    chip = p.locator(".ask-chip", has_text="Was bringt Bus-Priorität im Berufsverkehr?")
    chip.first.click()
    p.wait_for_function("() => document.querySelectorAll('#ask-chat .msg.bot').length > 0",
                        timeout=120000)
    p.wait_for_timeout(900)
    p.click("#ask-speak")
    t.hold(4, minimum=14)


def scene_network(t):
    p = t.page
    p.goto(BASE + "/network.html")
    p.wait_for_function("() => document.querySelectorAll('.kpi-table tbody tr').length > 0",
                        timeout=180000)
    p.evaluate("""() => {
        const sel = document.getElementById('ctl-region');
        sel.value = 'innenstadt';
        sel.dispatchEvent(new Event('change', {bubbles: true}));
    }""")
    time.sleep(0.5)
    p.select_option("#ctl-scenario", "berufsverkehr")
    p.wait_for_timeout(400)
    p.evaluate("""() => {
        const v = document.getElementById('ctl-vph');
        v.value = 9000;
        v.dispatchEvent(new Event('input', {bubbles: true}));
    }""")
    time.sleep(0.4)
    p.select_option("#ctl-mix", "city")
    time.sleep(0.5)
    p.click("#btn-run")
    p.wait_for_function(BUSYPOLL, timeout=240000)
    p.wait_for_timeout(6000)
    p.evaluate("document.querySelector('.kpi-panel').scrollIntoView({block:'start'})")
    time.sleep(0.8)
    t.hold(5)


def scene_map(t):
    p = t.page
    p.click("#btn-osm")
    p.wait_for_timeout(3500)
    p.evaluate("""() => {
        const o = document.getElementById('osm-opacity');
        o.value = 100;
        o.dispatchEvent(new Event('input', {bubbles: true}));
    }""")
    p.wait_for_timeout(1500)
    p.evaluate("document.querySelector('.viewer').scrollIntoView({block:'start'})")
    time.sleep(0.6)
    opened = p.evaluate("""() => {
        const cv = document.getElementById('canvas-fixed');
        const r = cv.getBoundingClientRect();
        const mk = (x, y) => new MouseEvent('click', {clientX: x, clientY: y, bubbles: true});
        for (let gx = r.left + 30; gx < r.right - 20; gx += 13) {
            for (let gy = r.top + 30; gy < r.bottom - 20; gy += 13) {
                cv.dispatchEvent(mk(gx, gy));
                if (!document.getElementById('drill').hidden) return true;
            }
        }
        return false;
    }""")
    time.sleep(1.2)
    if opened:
        head = p.locator(".drill-head h2").first
        box = head.bounding_box()
        if box:
            p.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            p.mouse.down()
            p.mouse.move(box["x"] + box["width"] / 2 + 430,
                         box["y"] + box["height"] / 2 + 10, steps=14)
            p.mouse.up()
    p.wait_for_timeout(900)
    p.evaluate("document.querySelector('.charts').scrollIntoView({block:'start'})")
    time.sleep(0.8)
    t.hold(6)


def scene_linger(t):
    p = t.page
    p.click(".cmode-btn[data-cmode='cum']")
    p.wait_for_timeout(500)
    p.click(".met-btn[data-met='co2']")
    p.wait_for_timeout(900)
    t.slow_scroll(400, steps=3, dwell=0.6)
    t.hold(7)


def scene_thanks(t):
    p = t.page
    p.click("a[href='writeup.html']")
    p.wait_for_timeout(1400)
    p.click("button[data-v='de-simple']")
    p.wait_for_timeout(900)
    t.slow_scroll(500, steps=3, dwell=0.5)
    p.evaluate("window.scrollTo(0, 0)")
    time.sleep(0.6)
    p.click("a[href='https://github.com/derKosi/SignalFlow']")
    p.wait_for_timeout(4500)
    t.hold(8)


SCENES = [
    ("intro", scene_intro),
    ("junction", scene_junction),
    ("toggles", scene_toggles),
    ("agent", scene_agent),
    ("network", scene_network),
    ("map", scene_map),
    ("linger", scene_linger),
    ("thanks", scene_thanks),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            record_video_dir=str(OUT),
            record_video_size={"width": 1920, "height": 1080},
        )
        page = context.new_page()
        take = Take(page)
        take.mark("lead-in")
        time.sleep(1.0)
        for name, fn in SCENES:
            print("scene:", name)
            take.mark(name)
            fn(take)
        take.marks.append({"scene": "_end", "start": round(time.perf_counter() - take.t0, 2)})
        video = page.video
        context.close()
        path = video.path()
        (OUT / "take.webm").write_bytes(pathlib.Path(path).read_bytes())
        (OUT / "timestamps.json").write_text(
            json.dumps(take.marks, indent=1), encoding="utf-8")
        print("take saved:", OUT / "take.webm")
        print("length:", take.marks[-1]["start"], "s")
        browser.close()


if __name__ == "__main__":
    main()
