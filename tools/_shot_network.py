"""Screenshot + PDF verification run for the adapted network dashboard.

Local, throwaway (tools/_shot_network.py): drives the real backend on
127.0.0.1:8000, takes milestone screenshots, and verifies the PDF report
bytes in-page (SFReport.download is intercepted, no real download).
"""
import asyncio
import pathlib

from playwright.async_api import async_playwright

OUT = pathlib.Path("shots")
OUT.mkdir(exist_ok=True)
BASE = "http://127.0.0.1:8000"


async def main() -> None:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={"width": 1680, "height": 1050})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        # ---------- network page ----------
        await page.goto(BASE + "/network.html")
        await page.wait_for_function(
            "() => document.querySelectorAll('#kpi-table tbody tr').length > 0", timeout=60000)
        await page.wait_for_timeout(1500)

        await page.screenshot(path=OUT / "n1-controls.png")
        await page.evaluate("document.querySelector('.viewer').scrollIntoView()")
        await page.screenshot(path=OUT / "n2-viewer.png")

        # strategy toggles: all three canvases
        await page.click(".pol-btn[data-pol='all']")
        await page.wait_for_timeout(400)
        await page.screenshot(path=OUT / "n3-all3.png")

        await page.evaluate("document.querySelector('.charts').scrollIntoView()")
        await page.screenshot(path=OUT / "n4-charts.png")

        # decisions panel + hotspot drilldown
        await page.evaluate("document.querySelector('.decisions').scrollIntoView()")
        await page.wait_for_timeout(200)
        await page.screenshot(path=OUT / "n5-decisions.png")
        clicked = await page.evaluate("""() => {
            const items = [...document.querySelectorAll('#hotspots-list .decision-item')];
            const li = items.find(x => !x.classList.contains('noclick'));
            if (!li) return null;
            li.click();
            return { opened: !document.getElementById('drill').hidden,
                     title: document.getElementById('drill-title').textContent };
        }""")
        await page.wait_for_timeout(400)
        await page.screenshot(path=OUT / "n6-drill.png")

        # drill open + map behind: close it again for the PDF capture
        await page.evaluate("document.getElementById('drill-close').click()")

        # ---------- PDF report: capture bytes in-page ----------
        await page.evaluate("""() => {
            window.__pdf = null;
            SFReport.download = (bytes, name) => { window.__pdf = bytes; window.__pdfName = name; };
        }""")
        await page.click("#btn-export")
        await page.wait_for_function("() => window.__pdf !== null", timeout=15000)
        pdf_info = await page.evaluate("""() => {
            const b = window.__pdf;
            const dec = new TextDecoder('latin1');
            const head = dec.decode(b.slice(0, 8));
            const tail = dec.decode(b.slice(-64));
            const startxref = Number(dec.decode(b.slice(-64)).split('startxref')[1].trim());
            return { name: window.__pdfName, size: b.length, head, tailOk: tail.includes('%%EOF'),
                     startxref };
        }""")
        # validate the xref table: every offset must point at "N 0 obj"
        xref_ok = await page.evaluate("""() => {
            const b = window.__pdf;
            const dec = new TextDecoder('latin1');
            const s = dec.decode(b);
            const sx = Number(s.split('startxref')[1].trim());
            const xref = s.slice(sx);
            const lines = xref.split('\\n').filter(l => l.includes(' 00000 n '));
            let bad = 0;
            for (const l of lines) {
                const off = Number(l.slice(0, 10));
                const at = dec.decode(b.slice(off, off + 12));
                if (!/^\\d+ 0 obj/.test(at)) bad++;
            }
            return { entries: lines.length, bad };
        }""")
        # save the pdf for an external eye
        import base64
        b64 = await page.evaluate("() => { let s=''; const u=new Uint8Array(window.__pdf);"
                                  "for (let i=0;i<u.length;i+=0x8000)"
                                  "s += String.fromCharCode.apply(null, u.subarray(i, i+0x8000));"
                                  "return btoa(s); }")
        (OUT / "netzwerk-bericht.pdf").write_bytes(base64.b64decode(b64))

        # ---------- junction page regression ----------
        await page.goto(BASE + "/index.html")
        await page.wait_for_function(
            "() => document.querySelectorAll('#kpi-table tbody tr').length > 0", timeout=60000)
        await page.wait_for_timeout(1200)
        await page.screenshot(path=OUT / "j1-junction.png")

        await browser.close()
        print("hotspot-drill:", clicked)
        print("pdf:", pdf_info)
        print("xref:", xref_ok)
        print("console errors:", errors[:5] if errors else "none")


if __name__ == "__main__":
    asyncio.run(main())
