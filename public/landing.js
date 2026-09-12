/*
 * VIVA landing — the only JavaScript on the page.
 *
 * No framework, no dependencies, served as a static file so the CSP stays at
 * script-src 'self' + nonce with no inline allowance. One job: the mobile menu.
 * (It also used to run a stat count-up; that row is gone because every figure
 * in it was an engineering metric rather than something a student cares about.)
 *
 * Written defensively so it behaves the same whether the browser honours the
 * tag's position or React hoists it into <head> and runs it before body parse.
 */
(function () {
  "use strict";

  function initMenu() {
    var burger = document.getElementById("vv-burger");
    var menu = document.getElementById("vv-menu");
    var overlay = document.getElementById("vv-overlay");
    if (!burger || !menu || !overlay) return;

    function setOpen(open) {
      burger.setAttribute("aria-expanded", open ? "true" : "false");
      burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      menu.hidden = !open;
      overlay.hidden = !open;
      document.body.classList.toggle("vv-menu-open", open);
      if (open) {
        var first = menu.querySelector("a");
        if (first) first.focus();
      }
    }

    burger.addEventListener("click", function () {
      setOpen(burger.getAttribute("aria-expanded") !== "true");
    });

    overlay.addEventListener("click", function () {
      setOpen(false);
    });

    // Links are real navigations, but close first so a cancelled route change
    // does not strand the sheet open.
    menu.addEventListener("click", function (e) {
      if (e.target && e.target.closest("a")) setOpen(false);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && burger.getAttribute("aria-expanded") === "true") {
        setOpen(false);
        burger.focus();
      }
    });

    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) return;
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        if (window.innerWidth > 720 && burger.getAttribute("aria-expanded") === "true") {
          setOpen(false);
        }
      }, 120);
    });
  }

  function init() {
    initMenu();
    // Sentinel: proves this file loaded past the CSP and executed.
    window.__vvLandingReady = true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
