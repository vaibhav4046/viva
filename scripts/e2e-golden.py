"""VIVA golden-path E2E (typed path only — no mic in headless, no AssemblyAI key).

Desktop pass (1440x900, video recorded) + mobile pass (390x844, reduced-motion).
Exits non-zero with the failing step name on any failure.
"""
import os
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("E2E_BASE", "http://localhost:3000")  # 3000: Privy's own CSP allowlists localhost:3000 for its iframe; other ports get frame-blocked in dev.
ROOT = Path(__file__).resolve().parent.parent
FOOT = ROOT / "demo-footage"
FOOT.mkdir(parents=True, exist_ok=True)
THOUGHT_1 = "I don't understand why attention needs positional encoding."
QUIZ_ME = "Quiz me on it."
WRONG_ANSWER = "It wouldn't know which words are important."
MISCONCEPTION_SNIPPET = "cannot tell first from last"
EXAM_Q_SNIPPET = "positional"  # /api/exam/start picks randomly within the concept pool (ex_pos_1/ex_pos_2)

console_errors: list[str] = []
page_errors: list[str] = []


def on_console(msg):
    if msg.type == "error":
        console_errors.append(f"[{msg.type}] {msg.text[:500]}")


def on_pageerror(exc):
    page_errors.append(f"{type(exc).__name__}: {str(exc)[:500]}")


def dump_logs(tag: str) -> None:
    print(f"--- console errors ({len(console_errors)}) [{tag}] ---")
    for line in console_errors[-10:]:
        print("  " + line)
    print(f"--- pageerrors ({len(page_errors)}) [{tag}] ---")
    for line in page_errors[-10:]:
        print("  " + line)


def wait_hydrated(page) -> None:
    """Deterministic hydration gate: React attaches __reactFiber$ props to DOM
    nodes on hydration. Without this, fills land before handlers exist and the
    Send click is a silent no-op (seen once Privy init lengthened hydration)."""
    page.wait_for_function(
        "() => { const el = document.querySelector('#viva-type');"
        " return !!(el && Object.keys(el).some(k => k.startsWith('__reactFiber'))); }",
        timeout=20000,
    )


def send_thought(page, text: str) -> None:
    wait_hydrated(page)
    page.fill("#viva-type", text)
    page.get_by_role("button", name="Send").click()


results: list[tuple[str, float]] = []


def run_step(name: str, fn) -> None:
    t0 = time.perf_counter()
    try:
        fn()
    except Exception as e:
        dt = (time.perf_counter() - t0) * 1000
        print(f"FAIL step={name} elapsed_ms={dt:.0f} err={type(e).__name__}: {str(e)[:400]}")
        traceback.print_exc()
        dump_logs(name)
        raise SystemExit(f"E2E FAILED at step: {name}: {e}")
    dt = (time.perf_counter() - t0) * 1000
    results.append((name, dt))
    print(f"PASS step={name} elapsed_ms={dt:.0f}")


def main() -> None:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--no-sandbox"])
        ctx = browser.new_context(
            viewport={"width": 1440, "height": 900},
            record_video_dir=str(FOOT),
        )
        page = ctx.new_page()
        page.on("console", on_console)
        page.on("pageerror", on_pageerror)

        def s_landing():
            page.goto(BASE + "/", wait_until="domcontentloaded", timeout=15000)
            page.locator("#hero").wait_for(timeout=10000)
            hero = page.locator("#hero").inner_text()
            assert "VIVA REMEMBERS" in hero, f"hero text missing, got: {hero[:200]!r}"
            link = page.get_by_role("link", name="Bring your own subject")
            assert link.count() >= 1, "'Bring your own subject' link not found"
            page.screenshot(path=str(FOOT / "shot-landing.png"))
            link.first.click()
            page.wait_for_url("**/subjects", timeout=10000)
            page.goto(BASE + "/study", wait_until="domcontentloaded", timeout=15000)

        def s_try_saying():
            """Three prompts that pre-fill the typed box, not a numbered script."""
            page.locator("#viva-type").wait_for(timeout=10000)
            wait_hydrated(page)
            chips = page.locator('button.chip')
            chips.first.wait_for(timeout=10000)
            assert chips.count() == 3, f"expected 3 'Try saying' chips, got {chips.count()}"
            chips.first.click()
            assert page.input_value("#viva-type").startswith("I don't understand"),                 "chip did not pre-fill the typed box"
            page.fill("#viva-type", "")
            page.screenshot(path=str(FOOT / "shot-study.png"))

        def s_thoughtmark():
            send_thought(page, THOUGHT_1)
            mark = page.locator('article[aria-label^="Note"]', has_text="Positional")
            mark.first.wait_for(timeout=15000)
            label = mark.first.get_attribute("aria-label") or ""
            assert "Positional" in label, f"note label missing Positional: {label!r}"
            page.screenshot(path=str(FOOT / "shot-note.png"))

        def s_quiz():
            send_thought(page, QUIZ_ME)
            exam = page.locator('section[aria-label="Quiz question"]')
            exam.wait_for(timeout=15000)
            q = exam.inner_text()
            assert EXAM_Q_SNIPPET in q.lower(), f"exam question missing, got: {q[:300]!r}"

        def s_exam_answer():
            # One input for everything: with a question open, the typed box is
            # the answer box. This is the routing the old build got wrong.
            page.fill("#viva-type", WRONG_ANSWER)
            page.press("#viva-type", "Enter")
            tutor = page.locator('section[aria-label="What VIVA said"]')
            tutor.wait_for(timeout=15000)
            page.wait_for_function(
                f"document.querySelector('section[aria-label=\"What VIVA said\"]')?.innerText.includes('{MISCONCEPTION_SNIPPET}')",
                timeout=15000,
            )
            page.screenshot(path=str(FOOT / "shot-exam.png"))

        def s_graph_node():
            node = page.locator("svg text", has_text="Positional")
            node.first.wait_for(timeout=10000)
            assert node.count() >= 1, "graph node for positional information not found"

        def s_evidence_link():
            link = page.locator('section[aria-label="What VIVA said"] a[href^="#chunk-"]').first
            link.wait_for(timeout=10000)
            link.click()
            page.wait_for_function("window.location.hash.includes('chunk-')", timeout=5000)
            assert "#chunk-" in page.url, f"hash missing after evidence click: {page.url}"

        def s_today():
            """VIVA 2.0: the 10-minute path surfaces from real history."""
            page.goto(BASE + "/today", wait_until="domcontentloaded", timeout=15000)
            # Wait for settlement: skeletons gone AND at least one path segment.
            page.wait_for_function(
                "() => { const t = document.body.innerText;"
                " return !t.includes(\"Composing today's path\")"
                " && !t.includes('Loading your review queue')"
                " && /min|minutes/.test(t); }",
                timeout=25000,
            )
            page.screenshot(path=str(FOOT / "shot-today.png"), full_page=True)

        def s_map():
            """The map lists every concept in the subject, in plain bands."""
            page.goto(BASE + "/map", wait_until="domcontentloaded", timeout=15000)
            page.wait_for_function(
                "() => { const t = document.body.innerText.toLowerCase();"
                " return t.includes('positional') && !t.includes('loading'); }",
                timeout=25000,
            )
            page.screenshot(path=str(FOOT / "shot-map.png"), full_page=True)

        for name, fn in [
            ("landing", s_landing),
            ("try-saying-chips", s_try_saying),
            ("note-positional", s_thoughtmark),
            ("quiz-exam-question", s_quiz),
            ("exam-misconception-feedback", s_exam_answer),
            ("graph-node", s_graph_node),
            ("evidence-link-hash", s_evidence_link),
            ("today-path", s_today),
            ("map-concepts", s_map),
        ]:
            run_step(name, fn)

        # Finalize desktop video -> golden-walkthrough.webm
        def s_video():
            video = page.video
            assert video is not None, "no video recorded (record_video_dir not active)"
            page.close()
            ctx.close()
            src = Path(str(video.path()))
            assert src.exists(), f"recorded video missing at {src}"
            dst = FOOT / "golden-walkthrough.webm"
            if dst.exists():
                dst.unlink()
            os.replace(src, dst)

        run_step("video-finalize", s_video)

        # Mobile pass: 390x844 + reduced motion, no video
        mctx = browser.new_context(
            viewport={"width": 390, "height": 844},
            reduced_motion="reduce",
            is_mobile=True,
        )
        mpage = mctx.new_page()
        mpage.on("console", on_console)
        mpage.on("pageerror", on_pageerror)

        def s_mobile():
            mpage.goto(BASE + "/study", wait_until="domcontentloaded", timeout=15000)
            mpage.locator("#viva-type").wait_for(timeout=10000)
            wait_hydrated(mpage)
            mpage.fill("#viva-type", THOUGHT_1)
            mpage.get_by_role("button", name="Send").click()
            mpage.locator('article[aria-label^="Note"]').first.wait_for(timeout=15000)
            mpage.screenshot(path=str(FOOT / "shot-mobile.png"))
            overflow = mpage.evaluate("document.body.scrollWidth")
            assert overflow <= 391, f"horizontal overflow on mobile: scrollWidth={overflow}"

        run_step("mobile-390-reduced-motion", s_mobile)
        mpage.close()
        mctx.close()
        browser.close()

    print("--- timings ---")
    for name, ms in results:
        print(f"  {name}: {ms:.0f}ms")
    print("--- artifacts ---")
    for fname in [
        "shot-landing.png",
        "shot-demo.png",
        "shot-thoughtmark.png",
        "shot-exam.png",
        "shot-mobile.png",
        "golden-walkthrough.webm",
    ]:
        fp = FOOT / fname
        print(f"  {fname}: {'MISSING' if not fp.exists() else f'{fp.stat().st_size} bytes'}")
    dump_logs("final")
    print("E2E ALL PASS")


if __name__ == "__main__":
    main()
